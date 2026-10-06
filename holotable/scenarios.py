"""Scenario files: <id>.json in the scenario folder (the game folder's
holotable/, where the engine finds them). Each has an owner - whoever made
it (older ones: createdBy) - who, with admins, is the only one who sees it
in Holotable. In game every scenario for the map is listed."""
import json
import os
import re
import secrets
import threading
import time

from . import config

FORMAT = 1
MAX_BYTES = 512 * 1024
_ID = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,62}$")
_lock = threading.Lock()

BEHAVIOURS = ("hunt", "route", "guard", "idle")
MODES = ("fa", "semi", "open", "legends", "keep")
SABER_COLORS = ("red", "orange", "yellow", "green", "blue", "purple")
WHENS = ("start", "timer", "enter_area", "all_in_area", "group_dead", "group_left", "all_dead", "players",
         "player_died", "npc_killed", "after", "counter", "countdown_end", "group_in_area", "use",
         "group_health", "leader_health", "prop_destroyed")
ACTIONS = ("spawn", "say", "tell", "message", "center", "sound", "music", "explode", "effect", "shake",
           "teleport", "use", "despawn", "win", "end", "respawn", "break", "prop",
           "give", "knockdown", "kill", "heal", "freeze", "vehicle", "pickup", "addtime", "move", "side", "arm",
           "trigger_on", "trigger_off", "counter", "countdown", "objective", "texture", "gravity", "speed",
           "loop_on", "loop_off", "log", "http")
WHO_FIXED = ("player", "all", "team1", "team2")
_NPC_NAME = re.compile(r"^HT_[A-Za-z0-9_]{1,40}$")


def _path(sid):
    if not _ID.match(str(sid or "")):
        raise ValueError("bad scenario id")
    return os.path.join(config.SCENARIO_DIR, sid + ".json")


def _slug(name):
    s = re.sub(r"[^a-z0-9]+", "_", str(name or "").lower()).strip("_")[:40]
    return s or "scenario"


def blank(name, mapname, author):
    return {
        "format": FORMAT,
        "name": name,
        "map": mapname,
        "description": "",
        "timeLimit": 900,
        "joinTeam": "any", "anytimeSpawn": False, "respawnSeconds": 5,
        "mode": "keep", "limitClasses": False, "classMode": "map", "classes": [],
        "points": [], "routes": [], "areas": [], "groups": [], "triggers": [], "npcTypes": [],
        "created": int(time.time()), "createdBy": author,
        "updated": int(time.time()), "updatedBy": author,
        "owner": author,
    }


def listing():
    out = []
    try:
        files = sorted(f for f in os.listdir(config.SCENARIO_DIR) if f.endswith(".json"))
    except FileNotFoundError:
        return out
    for f in files:
        sid = f[:-5]
        try:
            with open(os.path.join(config.SCENARIO_DIR, f), "r", encoding="utf-8") as fh:
                s = json.load(fh)
        except (ValueError, OSError):
            continue
        if not isinstance(s, dict):
            continue
        out.append({
            "id": sid, "name": s.get("name", sid), "map": s.get("map", ""), "description": s.get("description", ""),
            "updated": s.get("updated", 0), "updatedBy": s.get("updatedBy", ""),
            "owner": owner_of(s), "folder": s.get("folder", "") or "",
            "groups": len(s.get("groups", []) or []), "triggers": len(s.get("triggers", []) or []),
        })
    return out


def owner_of(data):
    return (data or {}).get("owner") or (data or {}).get("createdBy") or ""


def can_see(data, user):
    """Admins see every scenario; editors their own."""
    return user["role"] == "admin" or owner_of(data).lower() == user["username"].lower()


def clean_folder(folder):
    """A folder name: "Cantina" or nested, "Cantina/Raids" - just for sorting
    scenarios on the site (servers don't look at it). "" = none."""
    parts = [re.sub(r"[^\w \-'.,()&!]", "", p).strip()[:40] for p in str(folder or "").split("/")]
    return "/".join(p for p in parts if p)[:80]


def set_folder(sid, folder):
    """Moves a scenario into a folder (not counted as an edit)."""
    folder = clean_folder(folder)
    with _lock:
        data = load(sid)
        data["folder"] = folder
        _write(sid, data)
    return folder


def set_owner(sid, owner):
    with _lock:
        data = load(sid)
        data["owner"] = owner
        _write(sid, data)


def load(sid):
    with open(_path(sid), "r", encoding="utf-8") as f:
        return json.load(f)


def _write(sid, data):
    os.makedirs(config.SCENARIO_DIR, exist_ok=True)
    blob = json.dumps(data, indent=2, ensure_ascii=False)
    if len(blob.encode()) > MAX_BYTES:
        raise ValueError("scenario is too big")
    path = _path(sid)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(blob)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def create(name, mapname, author, folder=""):
    with _lock:
        base = _slug(name)
        sid = base
        while os.path.exists(_path(sid)):
            sid = "{}_{}".format(base, secrets.token_hex(2))
        data = blank(name, mapname, author)
        data["folder"] = clean_folder(folder)
        _write(sid, data)
    return sid


def duplicate(sid, author):
    data = load(sid)
    data["name"] = "{} (copy)".format(data.get("name", sid))
    data["created"] = data["updated"] = int(time.time())
    data["createdBy"] = data["updatedBy"] = data["owner"] = author
    suffix = secrets.token_hex(2).upper()
    renamed = {}
    for n in data.get("npcTypes", []) or []:
        new = "{}_{}".format(n.get("name", "HT_NPC")[:38], suffix)
        renamed[n.get("name", "")] = new
        n["name"] = new
    for g in data.get("groups", []) or []:
        g["npcs"] = [renamed.get(x, x) for x in g.get("npcs", []) or []]
        g["leader"] = renamed.get(g.get("leader", ""), g.get("leader", ""))
    with _lock:
        base = _slug(data["name"])
        new = base
        while os.path.exists(_path(new)):
            new = "{}_{}".format(base, secrets.token_hex(2))
        _write(new, data)
        write_npc_file()
    return new


def delete(sid):
    with _lock:
        os.remove(_path(sid))
        write_npc_file()


def _num(v, default=0.0):
    try:
        f = float(v)
        return f if f == f and abs(f) < 1e7 else default
    except (TypeError, ValueError):
        return default


def _text(v, n=200):
    return str(v or "")[:n]


def _breakable(src):
    """A prop's breakable settings (health 0 = can't be broken)."""
    snd = _text(src.get("breakSound"), 95)
    return {
        "health": int(max(0, min(100000, _num(src.get("health"), 0)))),
        "hitEffect": _text(src.get("hitEffect"), 63),
        "damagedEffect": _text(src.get("damagedEffect"), 63),
        "breakEffect": _text(src.get("breakEffect"), 63),
        "breakSound": snd if snd.startswith("sound/") else "",
        "blastDamage": int(max(0, min(1000, _num(src.get("blastDamage"), 0)))),
        "blastRadius": int(max(16, min(2048, _num(src.get("blastRadius"), 250)))),
    }


def _cond(t, when):
    """One of a trigger's whens - its own, or one of its "also" ones."""
    c = {
        "when": when,
        "area": _text(t.get("area"), 39), "group": _text(t.get("group"), 39), "trigger": _text(t.get("trigger"), 39),
        "seconds": round(max(0, min(3600, _num(t.get("seconds"), 0))), 1),
        "count": int(max(-9999, min(9999, _num(t.get("count"), 0)))),
        "counter": _text(t.get("counter"), 39),
        "compare": t.get("compare") if t.get("compare") in (">=", "==", "<=") else ">=",
    }
    if when in ("group_health", "leader_health"):
        c["percent"] = int(max(1, min(99, _num(t.get("percent"), 50))))
    if when == "prop_destroyed":
        c["prop"] = _text(t.get("prop"), 39)  # "" = any breakable prop
    if when == "use":
        # A player holds use at a point (within radius) or in an area.
        c["at"] = _text(t.get("at"), 39)
        c["radius"] = int(max(16, min(1024, _num(t.get("radius"), 64))))
        c["hold"] = round(max(0, min(120, _num(t.get("hold"), 3))), 1)
        c["bar"] = t.get("bar") is not False
        c["label"] = _text(t.get("label"), 60)
        c["sound"] = _text(t.get("sound"), 127) if str(t.get("sound") or "").startswith("sound/") else ""
        c["soundEvery"] = round(max(0.2, min(30, _num(t.get("soundEvery"), 1))), 1)
        c["team"] = t.get("team") if t.get("team") in ("team1", "team2") else "any"
    return c


def clean(data):
    """Keeps only what the format has, with the right types, so a bad page
    can't write anything odd into the game folder."""
    if not isinstance(data, dict):
        raise ValueError("not a scenario")

    def pos(o):
        return {"x": round(_num(o.get("x")), 1), "y": round(_num(o.get("y")), 1), "z": round(_num(o.get("z")), 1)}

    def lst(key):
        v = data.get(key) or []
        return v if isinstance(v, list) else []

    out = {
        "format": FORMAT,
        "name": _text(data.get("name"), 60) or "Untitled",
        "map": _text(data.get("map"), 64),
        "description": _text(data.get("description"), 200),
        "timeLimit": int(max(30, min(3600, _num(data.get("timeLimit"), 900)))),
        # Players: which side(s) they can join, and whether they respawn.
        "joinTeam": data.get("joinTeam") if data.get("joinTeam") in ("any", "team1", "team2") else "any",
        "anytimeSpawn": bool(data.get("anytimeSpawn")),
        "respawnSeconds": int(max(1, min(60, _num(data.get("respawnSeconds"), 5)))),
        # Starts again with every new round, once it's been run (till it's stopped).
        "everyRound": bool(data.get("everyRound")),
        # The classes players can pick (.mbch names), when limited.
        "limitClasses": bool(data.get("limitClasses")),
        # The MBII mode it plays in (the server reloads the map in it first).
        "mode": data.get("mode") if data.get("mode") in MODES else ("legends" if data.get("classMode") == "legends" else "fa"),
        "classMode": "legends" if data.get("mode") == "legends" or (not data.get("mode") and data.get("classMode") == "legends") else "map",
        "classes": [c for c in (re.sub(r"[^\w\-]", "", str(c or ""))[:39] for c in (data.get("classes") or [])[:256]) if c],
        # Legends: team configs instead of the Legends sides ("" = those) - g_siegeTeam1/2.
        "team1": re.sub(r"[^\w\-]", "", str(data.get("team1") or ""))[:63],
        "team2": re.sub(r"[^\w\-]", "", str(data.get("team2") or ""))[:63],
        "points": [], "routes": [], "areas": [], "groups": [], "triggers": [], "npcTypes": [], "counters": [],
        "props": [], "items": [], "vehicles": [], "effects": [], "sounds": [],
    }
    for p in lst("points")[:64]:
        if isinstance(p, dict):
            out["points"].append(dict(id=_text(p.get("id"), 39), name=_text(p.get("name"), 40), yaw=round(_num(p.get("yaw")) % 360, 1), **pos(p)))
    for r in lst("routes")[:16]:
        if isinstance(r, dict):
            pts = [pos(q) for q in (r.get("points") or [])[:64] if isinstance(q, dict)]
            out["routes"].append({"id": _text(r.get("id"), 39), "name": _text(r.get("name"), 40), "points": pts})
    for a in lst("areas")[:32]:
        if isinstance(a, dict):
            out["areas"].append(dict(id=_text(a.get("id"), 39), name=_text(a.get("name"), 40),
                                     radius=round(max(16, min(4096, _num(a.get("radius"), 128))), 1),
                                     height=round(max(32, min(4096, _num(a.get("height"), 128))), 1), **pos(a)))
    # Props and items there from the start (placed straight on the map).
    from . import gamedata
    for p in lst("props")[:64]:
        if isinstance(p, dict):
            model = str(p.get("model") or "")
            b = gamedata.prop_bounds(model) if re.match(r"^models/[\w/.\-]+\.md3$", model, re.I) else None
            if b:
                out["props"].append(dict(id=_text(p.get("id"), 39), name=_text(p.get("name"), 40), model=model,
                                         yaw=round(_num(p.get("yaw")) % 360, 1), mins=b[0], maxs=b[1], **pos(p), **_breakable(p)))
    for it in lst("items")[:64]:
        if isinstance(it, dict):
            item = str(it.get("item") or "")
            if re.match(r"^(item|weapon|ammo|holdable)_\w{1,40}$", item):
                out["items"].append(dict(id=_text(it.get("id"), 39), name=_text(it.get("name"), 40), item=item, **pos(it)))
    for v in lst("vehicles")[:16]:
        if isinstance(v, dict) and re.match(r"^[\w\-]{1,47}$", str(v.get("vehicle") or "")):
            out["vehicles"].append(dict(id=_text(v.get("id"), 39), name=_text(v.get("name"), 40), vehicle=str(v["vehicle"]),
                                        yaw=round(_num(v.get("yaw")) % 360, 1), **pos(v)))
    for e in lst("effects")[:32]:
        if isinstance(e, dict) and str(e.get("effect") or "").strip():
            out["effects"].append(dict(id=_text(e.get("id"), 39), name=_text(e.get("name"), 40), effect=_text(e.get("effect"), 95),
                                       every=round(max(0.2, min(60, _num(e.get("every"), 1))), 1),
                                       startOff=bool(e.get("startOff")), **pos(e)))
    for so in lst("sounds")[:32]:
        if isinstance(so, dict) and str(so.get("sound") or "").startswith("sound/"):
            out["sounds"].append(dict(id=_text(so.get("id"), 39), name=_text(so.get("name"), 40), sound=_text(so.get("sound"), 127),
                                      startOff=bool(so.get("startOff")), **pos(so)))
    for g in lst("groups")[:16]:
        if isinstance(g, dict):
            npcs = [_text(n, 47) for n in (g.get("npcs") or [])[:8] if str(n or "").strip()]
            b = g.get("behaviour") if g.get("behaviour") in BEHAVIOURS else "hunt"
            out["groups"].append({
                "id": _text(g.get("id"), 39), "name": _text(g.get("name"), 47), "npcs": npcs,
                "leader": _text(g.get("leader"), 47), "count": int(max(0, min(32, _num(g.get("count"), 1)))),
                "perPlayer": int(max(0, min(8, _num(g.get("perPlayer"), 0)))), "max": int(max(1, min(32, _num(g.get("max"), 20)))),
                "spawn": _text(g.get("spawn"), 39), "spawnAtStart": bool(g.get("spawnAtStart")),
                "behaviour": b, "route": _text(g.get("route"), 39),
                "routePace": "run" if g.get("routePace") == "run" else "walk",
                "engage": int(max(0, min(4096, _num(g.get("engage"), 0)))),
                "attacks": g.get("attacks") if g.get("attacks") in ("all", "team1", "team2", "none") else "all",
            })
    for t in lst("triggers")[:32]:
        if not isinstance(t, dict):
            continue
        when = t.get("when") if t.get("when") in WHENS else "start"
        acts = []
        for a in (t.get("actions") or [])[:16]:
            if not isinstance(a, dict) or a.get("do") not in ACTIONS:
                continue
            d = a["do"]
            act = {"do": d}
            if d in ("spawn", "despawn"):
                act["group"] = _text(a.get("group"), 39)
                if d == "spawn":
                    act["at"] = _text(a.get("at"), 39)  # "" = the group's own spawn place
            elif d == "say":
                act["speaker"] = _text(a.get("speaker"), 40)
                act["text"] = _text(a.get("text"), 190)
                act["path"] = _text(a.get("path"), 120)
            elif d == "tell":
                act["text"] = _text(a.get("text"), 190)
                act["style"] = "center" if a.get("style") == "center" else "chat"
            elif d == "sound":
                act["path"] = _text(a.get("path"), 120)
                act["at"] = _text(a.get("at"), 39)
            elif d == "music":
                act["path"] = _text(a.get("path"), 120)
            elif d in ("explode", "effect", "shake"):
                act["at"] = _text(a.get("at"), 39)
                if d != "shake":
                    act["effect"] = _text(a.get("effect"), 95)
                    act["path"] = _text(a.get("path"), 120)
                if d == "explode":
                    act["damage"] = int(max(0, min(1000, _num(a.get("damage"), 60))))
                    act["radius"] = int(max(16, min(2048, _num(a.get("radius"), 250))))
                if d == "shake":
                    act["intensity"] = round(max(0.5, min(20, _num(a.get("intensity"), 4))), 1)
                    act["seconds"] = round(max(0.1, min(10, _num(a.get("seconds"), 1))), 1)
            elif d == "teleport":
                act["at"] = _text(a.get("at"), 39)
                act["who"] = "all" if a.get("who") == "all" else "player"
            elif d == "use":
                act["target"] = _text(a.get("target"), 63)
            elif d == "respawn":
                act["team"] = a.get("team") if a.get("team") in ("team1", "team2") else "both"
                act["where"] = _text(a.get("where"), 39)  # a point or route; "" = the map's own spawns
            elif d == "prop":
                # Its solid box comes from the model itself.
                from . import gamedata
                model = str(a.get("model") or "")
                b = gamedata.prop_bounds(model) if re.match(r"^models/[\w/.\-]+\.md3$", model, re.I) else None
                act["model"] = model if b else ""
                act["at"] = _text(a.get("at"), 39)
                if a.get("yaw") not in (None, ""):
                    act["yaw"] = int(_num(a.get("yaw"), 0)) % 360
                if b:
                    act["mins"], act["maxs"] = b
                act.update(_breakable(a))
            elif d == "break":
                m = str(a.get("model") or "")
                act["model"] = m if re.match(r"^\*\d{1,4}$", m) else ""
                act["target"] = _text(a.get("target"), 63)
            elif d in ("give", "knockdown", "kill", "heal", "freeze"):
                act["who"] = _text(a.get("who") or "player", 39)
                if d == "give":
                    act["item"] = _text(a.get("item"), 63)
                if d in ("knockdown", "freeze"):
                    act["seconds"] = round(max(0.5, min(60, _num(a.get("seconds"), 3))), 1)
            elif d in ("vehicle", "pickup"):
                act["at"] = _text(a.get("at"), 39)
                act["vehicle" if d == "vehicle" else "item"] = _text(a.get("vehicle" if d == "vehicle" else "item"), 63)
            elif d == "addtime":
                act["seconds"] = int(max(-3600, min(3600, _num(a.get("seconds"), 60))))
            elif d == "move":
                act["group"] = _text(a.get("group"), 39)
                act["behaviour"] = a.get("behaviour") if a.get("behaviour") in BEHAVIOURS + ("follow", "follow_class") else "hunt"
                if act["behaviour"] == "follow_class":
                    act["class"] = re.sub(r"[^\w\-]", "", str(a.get("class") or ""))[:39]
                act["route"] = _text(a.get("route"), 39)
                act["pace"] = "run" if a.get("pace") == "run" else "walk"
                act["at"] = _text(a.get("at"), 39)
            elif d == "arm":
                act["group"] = _text(a.get("group"), 39)
                w = str(a.get("weapon") or "")
                act["weapon"] = w if re.match(r"^WP_[A-Z0-9_]{2,24}$", w) and w != "WP_SABER" else "WP_BLASTER"
            elif d == "side":
                act["group"] = _text(a.get("group"), 39)
                act["attacks"] = a.get("attacks") if a.get("attacks") in ("all", "team1", "team2", "none") else "all"
            elif d in ("trigger_on", "trigger_off"):
                act["trigger"] = _text(a.get("trigger"), 39)
            elif d == "counter":
                act["counter"] = _text(a.get("counter"), 39)
                act["op"] = a.get("op") if a.get("op") in ("add", "set", "random") else "add"
                act["value"] = int(max(-9999, min(9999, _num(a.get("value"), 1))))
                if act["op"] == "random":
                    # A whole number from min to max, both included.
                    act["min"] = int(max(-9999, min(9999, _num(a.get("min"), 1))))
                    act["max"] = int(max(-9999, min(9999, _num(a.get("max"), 6))))
            elif d == "countdown":
                act["seconds"] = int(max(1, min(3600, _num(a.get("seconds"), 30))))
                act["text"] = _text(a.get("text"), 90)
            elif d == "objective":
                act["team"] = "team2" if a.get("team") == "team2" else "team1"
                act["objective"] = int(max(1, min(32, _num(a.get("objective"), 1))))
            elif d == "texture":
                act["from"] = _text(a.get("from"), 95)
                act["to"] = _text(a.get("to"), 95)
            elif d in ("gravity", "speed"):
                # gravity: the g_gravity value (normal 800); speed: % of normal
                act["value"] = (int(max(0, min(5000, _num(a.get("value"), 800)))) if d == "gravity"
                                else int(max(10, min(400, _num(a.get("value"), 200)))))
                act["seconds"] = int(max(0, min(3600, _num(a.get("seconds"), 0))))
            elif d in ("loop_on", "loop_off"):
                act["target"] = _text(a.get("target"), 39)  # a placed effect or sound
            elif d == "log":
                act["text"] = re.sub(r"[\r\n%]", " ", _text(a.get("text"), 190))
            elif d == "http":
                url = str(a.get("url") or "").strip()[:250]
                act["url"] = url if re.match(r"^https?://[^\s]+$", url) else ""
                act["method"] = "POST" if a.get("method") == "POST" else "GET"
                act["body"] = _text(a.get("body"), 500)
                ct = re.sub(r"[\r\n]", "", str(a.get("contentType") or "application/json"))[:80]
                act["contentType"] = ct or "application/json"
            elif d == "win":
                act["team"] = a.get("team") if a.get("team") in ("team1", "team2", "draw") else "team1"
                act["text"] = _text(a.get("text"), 190)
            else:
                act["text"] = _text(a.get("text"), 190)
            acts.append(act)
        trig = {"id": _text(t.get("id"), 39), "name": _text(t.get("name"), 47)}
        trig.update(_cond(t, when))
        # More whens: all of them, or any one ("use" once at most).
        also = []
        uses = when == "use"
        for x in (t.get("also") or [])[:3]:
            if isinstance(x, dict) and x.get("when") in WHENS and not (uses and x.get("when") == "use"):
                uses = uses or x.get("when") == "use"
                also.append(_cond(x, x["when"]))
        if also:
            trig["also"] = also
            trig["match"] = "any" if t.get("match") == "any" else "all"
        trig.update({
            "startOff": bool(t.get("startOff")),
            "repeat": bool(t.get("repeat")), "cooldown": round(max(1, min(3600, _num(t.get("cooldown"), 5))), 1),
            "actions": acts,
        })
        out["triggers"].append(trig)
    for c in lst("counters")[:16]:
        if isinstance(c, dict) and c.get("id"):
            out["counters"].append({"id": _text(c.get("id"), 39), "name": _text(c.get("name"), 40),
                                    "start": int(max(-9999, min(9999, _num(c.get("start"), 0))))})
    for n in lst("npcTypes")[:24]:
        if not isinstance(n, dict):
            continue
        name = re.sub(r"[^A-Za-z0-9_]", "", str(n.get("name") or ""))[:43]
        if not name.upper().startswith("HT_"):
            name = "HT_" + name
        if not _NPC_NAME.match(name):
            continue
        weapon = str(n.get("weapon") or "WP_BLASTER")
        out["npcTypes"].append({
            "name": name,
            "model": re.sub(r"[^\w\-]", "", str(n.get("model") or ""))[:48],
            "skin": re.sub(r"[^\w\-]", "", str(n.get("skin") or "default"))[:48] or "default",
            "weapon": weapon if re.match(r"^WP_[A-Z0-9_]{2,24}$", weapon) else "WP_BLASTER",
            "altFire": bool(n.get("altFire")),
            "health": int(max(1, min(5000, _num(n.get("health"), 100)))),
            "armor": int(max(0, min(1000, _num(n.get("armor"), 0)))),
            "scale": int(max(40, min(250, _num(n.get("scale"), 100)))),
            "skill": int(max(1, min(5, _num(n.get("skill"), 3)))),
            "runSpeed": int(max(50, min(400, _num(n.get("runSpeed"), 210)))),
            "saberColor": n.get("saberColor") if n.get("saberColor") in SABER_COLORS else "blue",
            # The hilt(s): any of the game's saber definitions ("" = a plain single saber, no second).
            "saber": re.sub(r"[^\w\-]", "", str(n.get("saber") or ""))[:47],
            "saber2": re.sub(r"[^\w\-]", "", str(n.get("saber2") or ""))[:47],
            "saber2Color": n.get("saber2Color") if n.get("saber2Color") in SABER_COLORS else "red",
            # Single-saber style, 1-5 (fast, medium, strong, Desann, Tavion); 0 = the saber's own.
            # Two sabers fight dual and a staff hilt staff by themselves.
            "saberStyle": int(max(0, min(5, _num(n.get("saberStyle"), 0)))),
            # MBII attributes ("MB_ATT_GUN_DEFENSE 2"...) - passive ones work on NPCs.
            "attributes": [{"id": a["id"], "level": int(max(1, min(100, _num(a.get("level"), 1))))}
                           for a in (n.get("attributes") or [])[:24]
                           if isinstance(a, dict) and re.match(r"^MB_ATT_[A-Z0-9_]{2,40}$", str(a.get("id") or ""))],
            # Saber blocking (MBII's PBchance / MBchance / SBchance) and force pool; 0 = the game's own.
            "pbChance": int(max(0, min(100, _num(n.get("pbChance"), 0)))),
            "mbChance": int(max(0, min(100, _num(n.get("mbChance"), 0)))),
            "sbChance": int(max(0, min(100, _num(n.get("sbChance"), 0)))),
            "forcePool": int(max(0, min(1000, _num(n.get("forcePool"), 0)))),
            "peaceful": bool(n.get("peaceful")),
        })
    return out


# --- NPC types -> the game's NPC folder --------------------------------------
#
# MBII reads ext_data/NPCs/*.npc when a map loads. Every scenario's own types
# go into one file there, holotable.npc, rewritten on each save; the engine
# has MBII read them again when it changes, before a scenario starts. A
# peaceful type is neutral, like MBII's bartender: it attacks
# nobody and nobody's NPCs go for it.

NPC_FILE = os.path.join("ext_data", "NPCs", "holotable.npc")


def _npc_block(n):
    k = n["skill"]
    lines = [
        n["name"], "{",
        "\tplayerModel\t{}".format(n["model"] or "stormtrooper"),
        "\tcustomSkin\t{}".format(n["skin"]),
        "\tweapon\t\t{}".format(n["weapon"]),
    ]
    if n["altFire"]:
        lines.append("\taltFire\t\t1")
    if n["weapon"] == "WP_SABER":
        lines.append("\tsaber\t\t{}".format(n.get("saber") or "single_1"))
        # Types saved before the colour option have none: blue, as the editor shows them.
        lines.append("\tsaberColor\t{}".format(n.get("saberColor") if n.get("saberColor") in SABER_COLORS else "blue"))
        if n.get("saber2"):
            lines.append("\tsaber2\t\t{}".format(n["saber2"]))
            lines.append("\tsaber2Color\t{}".format(n.get("saber2Color") if n.get("saber2Color") in SABER_COLORS else "red"))
        if n.get("saberStyle"):
            lines.append("\tsaberStyle\t{}".format(n["saberStyle"]))
    seen = set()
    for a in n.get("attributes") or []:
        if a["id"] not in seen:
            seen.add(a["id"])
            lines.append("\t{}\t{}".format(a["id"], a["level"]))
    for key, field in (("PBchance", "pbChance"), ("MBchance", "mbChance"), ("SBchance", "sbChance"), ("forcePowerMax", "forcePool")):
        if n.get(field):
            lines.append("\t{}\t{}".format(key, n[field]))
    lines += [
        "\thealth\t\t{}".format(n["health"]),
        "\tarmor\t\t{}".format(n["armor"]),
    ]
    if n["scale"] != 100:
        lines.append("\tscale\t\t{}".format(n["scale"]))
    for key in ("reactions", "aim", "move", "aggression", "evasion", "intelligence"):
        lines.append("\t{}\t{}".format(key, k))
    lines += [
        "\trank\t\t{}".format("ensign" if k >= 4 else "crewman"),
        "\tplayerTeam\t{}".format("TEAM_NEUTRAL" if n.get("peaceful") else "TEAM_FREE"),
        "\tenemyTeam\t{}".format("TEAM_NEUTRAL" if n.get("peaceful") else "TEAM_PLAYER"),
        "\tclass\t\t{}".format("CLASS_REBORN" if n["weapon"] == "WP_SABER" else "CLASS_STORMTROOPER"),
        "\tyawspeed\t{}".format(60 + 12 * k),
        "\twalkSpeed\t55",
        "\trunSpeed\t{}".format(n["runSpeed"]),
        "}", "",
    ]
    return "\n".join(lines)


def _all_npc_types(skip=None):
    """name (lower) -> (scenario id, type) over every saved scenario."""
    out = {}
    for s in listing():
        if s["id"] == skip:
            continue
        try:
            data = load(s["id"])
        except (ValueError, OSError):
            continue
        for n in data.get("npcTypes", []) or []:
            if isinstance(n, dict) and n.get("name"):
                out.setdefault(n["name"].lower(), (s["id"], n))
    return out


def write_npc_file():
    types = sorted(_all_npc_types().values(), key=lambda v: v[1]["name"].lower())
    path = os.path.join(config.GAMEDATA, NPC_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = "// Written by Holotable - NPC types from its scenarios. Edits here are overwritten.\n\n"
    body += "\n".join("// {}\n{}".format(sid, _npc_block(n)) for sid, n in types)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(body)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def _web_requests(scn):
    """A scenario's http actions, as what they'd send."""
    return sorted((a.get("method", ""), a.get("url", ""), a.get("body", ""), a.get("contentType", ""))
                  for t in (scn.get("triggers") or []) for a in (t.get("actions") or []) if a.get("do") == "http")


def save(sid, data, author, admin=False):
    cleaned = clean(data)
    with _lock:
        try:
            old = load(sid)
        except FileNotFoundError:
            old = {}
        # Web requests come from the game server itself (inside its network),
        # so only admins add or change them; an editor keeps any already there.
        if not admin and _web_requests(cleaned) != _web_requests(old):
            raise ValueError("Only admins can add or change web request (HTTP) actions.")
        cleaned["created"] = old.get("created", int(time.time()))
        cleaned["createdBy"] = old.get("createdBy", author)
        cleaned["owner"] = owner_of(old) or author
        cleaned["folder"] = old.get("folder", "") or ""  # only moved from the list, never by the editor
        cleaned["updated"] = int(time.time())
        cleaned["updatedBy"] = author
        # NPC type names are shared by every scenario on the server.
        others = _all_npc_types(skip=sid)
        seen = set()
        for n in cleaned["npcTypes"]:
            key = n["name"].lower()
            if key in seen:
                raise ValueError("Two NPC types are called {}.".format(n["name"]))
            seen.add(key)
            if key in others:
                raise ValueError("NPC type {} is already used by scenario '{}' - pick another name.".format(n["name"], others[key][0]))
        _write(sid, cleaned)
        write_npc_file()
    return cleaned
