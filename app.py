"""Holotable - build NPC scenarios for MBII servers on a top-down map.

Run: python app.py (settings in .env - see .env.example).
"""
import re
import time
from functools import wraps

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, session, url_for

from holotable import config, gamedata, scenarios, users

__version__ = "0.1.1"

app = Flask(__name__)
app.secret_key = config.secret_key()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", MAX_CONTENT_LENGTH=1024 * 1024)

_failed_logins = {}


def current_user():
    name = session.get("user")
    if not name:
        return None
    role = users.role_of(name)  # deleted since logging in: logged out
    if not role:
        session.clear()
        return None
    return {"username": name, "role": role}


def login_required(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Not logged in."}), 401
            return redirect(url_for("login", next=request.path))
        return func(*args, **kwargs)
    return wrapper


def admin_required(func):
    @wraps(func)
    @login_required
    def wrapper(*args, **kwargs):
        if current_user()["role"] != "admin":
            return jsonify({"ok": False, "error": "Admins only."}), 403
        return func(*args, **kwargs)
    return wrapper


@app.before_request
def csrf_guard():
    # Changes come from our own pages' fetch() calls, which send this header;
    # another site can't send it cross-origin without our say-so.
    if request.method == "POST" and request.path.startswith("/api/") and request.headers.get("X-Holotable") != "1":
        abort(403)


@app.context_processor
def inject():
    return {"user": current_user(), "version": __version__}


def ok(**kw):
    return jsonify(dict(ok=True, **kw))


def fail(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


# --- Pages ------------------------------------------------------------------

@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        ip = request.remote_addr or "?"
        recent = [t for t in _failed_logins.get(ip, []) if time.time() - t < 300]
        if len(recent) >= 10:
            error = "Too many attempts - try again in a few minutes."
        else:
            name = request.form.get("username", "").strip()
            role = users.check(name, request.form.get("password", ""))
            if role:
                session.clear()
                session["user"] = next(u["username"] for u in users.listing() if u["username"].lower() == name.lower())
                _failed_logins.pop(ip, None)
                nxt = request.args.get("next", "/")
                return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else "/")
            recent.append(time.time())
            _failed_logins[ip] = recent
            error = "Wrong username or password."
    return render_template("login.html", error=error)


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def index():
    me = current_user()
    visible = [s for s in scenarios.listing() if me["role"] == "admin" or s["owner"].lower() == me["username"].lower()]
    return render_template("index.html", scenarios=visible, maps=gamedata.list_maps(),
                           usernames=[u["username"] for u in users.listing()])


def own_scenario(sid):
    """The scenario, if it exists and the user may see it (else None - an
    editor gets "no such scenario" for anyone else's, as if it isn't there)."""
    try:
        data = scenarios.load(sid)
    except (FileNotFoundError, ValueError):
        return None
    return data if scenarios.can_see(data, current_user()) else None


@app.route("/edit/<sid>")
@login_required
def edit(sid):
    if own_scenario(sid) is None:
        abort(404)
    return render_template("editor.html", sid=sid)


@app.route("/users")
@login_required
def users_page():
    if current_user()["role"] != "admin":
        abort(403)
    return render_template("users.html", users=users.listing(), handles=users.game_handles())


@app.route("/health")
def health():
    return {"ok": True, "version": __version__}


# --- API: game data -----------------------------------------------------------

@app.route("/api/maps")
@login_required
def api_maps():
    return ok(maps=gamedata.list_maps())


@app.route("/api/maps/<name>/geometry")
@login_required
def api_geometry(name):
    try:
        blob = gamedata.geometry_json(name)
    except Exception as e:
        return fail("Couldn't read that map: {}".format(e), 500)
    if blob is None:
        return fail("No such map.", 404)
    return Response(blob, mimetype="application/json", headers={"Content-Encoding": "gzip", "Cache-Control": "private, max-age=3600"})


@app.route("/api/maps/<name>/entities")
@login_required
def api_map_entities(name):
    try:
        return ok(entities=gamedata.map_entities(name))
    except Exception as e:
        return fail("Couldn't read that map: {}".format(e), 500)


@app.route("/api/maps/<name>/teams")
@login_required
def api_map_teams(name):
    return ok(teams=gamedata.map_teams(name))


@app.route("/api/npcs")
@login_required
def api_npcs():
    return ok(npcs=gamedata.list_npcs())


@app.route("/api/models")
@login_required
def api_models():
    return ok(models=gamedata.list_models(), weapons=gamedata.WEAPONS)


@app.route("/api/models/<model>/<skin>/icon")
@login_required
def api_model_icon(model, skin):
    hit = gamedata.model_icon(model, skin)
    if not hit:
        # No icon: an empty image rather than a 404 (the page just shows none).
        return Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', mimetype="image/svg+xml",
                        headers={"Cache-Control": "private, max-age=3600", "X-No-Icon": "1"})
    return Response(hit[0], mimetype=hit[1], headers={"Cache-Control": "private, max-age=86400"})


@app.route("/api/vehicles")
@login_required
def api_vehicles():
    return ok(vehicles=gamedata.list_vehicles(), items=gamedata.list_items())


@app.route("/api/maps/<name>/shaders")
@login_required
def api_map_shaders(name):
    try:
        return ok(shaders=gamedata.map_shaders(name))
    except Exception as e:
        return fail("Couldn't read that map: {}".format(e), 500)


@app.route("/api/maps/<name>/classes")
@login_required
def api_map_classes(name):
    # A scenario's own teams (Full Authentic), instead of the map's.
    team1 = re.sub(r"[^\w\-]", "", request.args.get("team1", ""))[:63]
    team2 = re.sub(r"[^\w\-]", "", request.args.get("team2", ""))[:63]
    return ok(classes=gamedata.map_classes(name, team1, team2))


@app.route("/api/sabers")
@login_required
def api_sabers():
    return ok(sabers=gamedata.sabers())


@app.route("/api/attributes")
@login_required
def api_attributes():
    return ok(attributes=gamedata.attributes())


@app.route("/api/teams")
@login_required
def api_teams():
    return ok(teams=gamedata.team_configs())


@app.route("/api/maps/<name>/objectives")
@login_required
def api_map_objectives(name):
    return ok(objectives=gamedata.map_objectives(name))


@app.route("/api/effects")
@login_required
def api_effects():
    return ok(effects=gamedata.search_effects(request.args.get("q", "")))


@app.route("/api/maps/<name>/targets")
@login_required
def api_map_targets(name):
    try:
        return ok(targets=gamedata.map_targets(name))
    except Exception as e:
        return fail("Couldn't read that map: {}".format(e), 500)


@app.route("/api/music")
@login_required
def api_music():
    return ok(music=gamedata.list_music())


@app.route("/api/sounds")
@login_required
def api_sounds():
    return ok(sounds=gamedata.search_sounds(request.args.get("q", "")))


@app.route("/api/sound")
@login_required
def api_sound():
    hit = gamedata.sound_file(request.args.get("path", ""))
    if not hit:
        abort(404)
    return Response(hit[0], mimetype=hit[1], headers={"Cache-Control": "private, max-age=86400"})


# --- API: scenarios -------------------------------------------------------------

@app.route("/api/scenarios/<sid>")
@login_required
def api_scenario(sid):
    data = own_scenario(sid)
    if data is None:
        return fail("No such scenario.", 404)
    return ok(scenario=data)


@app.route("/api/scenarios", methods=["POST"])
@login_required
def api_create():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()[:60]
    mapname = str(data.get("map", "")).strip()
    entry = gamedata.find_map(mapname)
    if not name:
        return fail("Give it a name.")
    if not entry:
        return fail("That map isn't in the game folder.")
    return ok(id=scenarios.create(name, entry["name"], current_user()["username"]))


@app.route("/api/scenarios/<sid>", methods=["POST"])
@login_required
def api_save(sid):
    if own_scenario(sid) is None:
        return fail("No such scenario.", 404)
    try:
        saved = scenarios.save(sid, request.get_json(silent=True), current_user()["username"])
    except ValueError as e:
        return fail(str(e))
    return ok(scenario=saved)


@app.route("/api/scenarios/<sid>/duplicate", methods=["POST"])
@login_required
def api_duplicate(sid):
    if own_scenario(sid) is None:
        return fail("No such scenario.", 404)
    try:
        return ok(id=scenarios.duplicate(sid, current_user()["username"]))
    except (FileNotFoundError, ValueError):
        return fail("No such scenario.", 404)


@app.route("/api/scenarios/<sid>/delete", methods=["POST"])
@login_required
def api_delete(sid):
    if own_scenario(sid) is None:
        return fail("No such scenario.", 404)
    try:
        scenarios.delete(sid)
    except (FileNotFoundError, ValueError):
        return fail("No such scenario.", 404)
    return ok()


@app.route("/api/scenarios/<sid>/owner", methods=["POST"])
@admin_required
def api_owner(sid):
    owner = str((request.get_json(silent=True) or {}).get("owner", "")).strip()
    if not users.role_of(owner):
        return fail("No such user.")
    try:
        scenarios.set_owner(sid, next(u["username"] for u in users.listing() if u["username"].lower() == owner.lower()))
    except (FileNotFoundError, ValueError):
        return fail("No such scenario.", 404)
    return ok(message="Now {}'s.".format(owner))


# --- API: accounts ------------------------------------------------------------

@app.route("/api/users/add", methods=["POST"])
@admin_required
def api_user_add():
    d = request.get_json(silent=True) or {}
    success, msg = users.add(d.get("username"), d.get("password"), d.get("role", "editor"))
    return ok(message=msg) if success else fail(msg)


@app.route("/api/users/password", methods=["POST"])
@login_required
def api_user_password():
    d = request.get_json(silent=True) or {}
    me = current_user()
    target = d.get("username") or me["username"]
    if target.lower() != me["username"].lower() and me["role"] != "admin":
        return fail("Admins only.", 403)
    success, msg = users.set_password(target, d.get("password"))
    return ok(message=msg) if success else fail(msg)


@app.route("/api/users/role", methods=["POST"])
@admin_required
def api_user_role():
    d = request.get_json(silent=True) or {}
    success, msg = users.set_role(d.get("username"), d.get("role"))
    return ok(message=msg) if success else fail(msg)


@app.route("/api/users/game", methods=["POST"])
@admin_required
def api_user_game():
    d = request.get_json(silent=True) or {}
    success, msg = users.set_game_link(d.get("username"), d.get("handle"),
                                       d.get("can_run") if "can_run" in d else None)
    return ok(message=msg) if success else fail(msg)


@app.route("/api/users/delete", methods=["POST"])
@admin_required
def api_user_delete():
    d = request.get_json(silent=True) or {}
    if str(d.get("username", "")).lower() == current_user()["username"].lower():
        return fail("You can't delete yourself.")
    success, msg = users.delete(d.get("username"))
    return ok(message=msg) if success else fail(msg)


def main():
    warning = users.bootstrap()
    if warning:
        print("Holotable: " + warning)
    print("Holotable {} on http://{}:{} - game data {}, scenarios in {}".format(
        __version__, config.HOST, config.PORT, config.GAMEDATA, config.SCENARIO_DIR))
    try:
        from waitress import serve
        serve(app, host=config.HOST, port=config.PORT, threads=8)
    except ImportError:
        app.run(host=config.HOST, port=config.PORT)


if __name__ == "__main__":
    main()
