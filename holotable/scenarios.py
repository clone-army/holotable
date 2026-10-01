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
SABER_COLORS = ("red", "orange", "yellow", "green", "blue", "purple")
WHENS = ("start", "timer", "enter_area", "all_in_area", "group_dead", "group_left", "all_dead", "players",
         "player_died", "npc_killed", "after", "counter", "countdown_end")
ACTIONS = ("spawn", "say", "tell", "message", "center", "sound", "music", "explode", "effect", "shake",
           "teleport", "use", "despawn", "win", "end",
           "give", "knockdown", "kill", "heal", "freeze", "vehicle", "pickup", "addtime", "move",
           "trigger_on", "trigger_off", "counter", "countdown", "objective", "texture", "gravity", "speed")
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
        "limitClasses": False, "classMode": "map", "classes": [],
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
            "owner": owner_of(s),
            "groups": len(s.get("groups", []) or []), "triggers": len(s.get("triggers", []) or []),
        })
    return out


def owner_of(data):
    return (data or {}).get("owner") or (data or {}).get("createdBy") or ""


def can_see(data, user):
    """Admins see every scenario; editors their own."""
    return user["role"] == "admin" or owner_of(data).lower() == user["username"].lower()


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


def create(name, mapname, author):
    with _lock:
        base = _slug(name)
        sid = base
        while os.path.exists(_path(sid)):
            sid = "{}_{}".format(base, secrets.token_hex(2))
        _write(sid, blank(name, mapname, author))
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
        # The classes players can pick (.mbch names), when limited.
        "limitClasses": bool(data.get("limitClasses")),
        "classMode": "legends" if data.get("classMode") == "legends" else "map",
        "classes": [c for c in (re.sub(r"[^\w\-]", "", str(c or ""))[:39] for c in (data.get("classes") or [])[:256]) if c],
        "points": [], "routes": [], "areas": [], "groups": [], "triggers": [], "npcTypes": [], "counters": [],
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
                "attacks": g.get("attacks") if g.get("attacks") in ("all", "team1", "team2") else "all",
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
                act["behaviour"] = a.get("behaviour") if a.get("behaviour") in BEHAVIOURS else "hunt"
                act["route"] = _text(a.get("route"), 39)
                act["pace"] = "run" if a.get("pace") == "run" else "walk"
                act["at"] = _text(a.get("at"), 39)
            elif d in ("trigger_on", "trigger_off"):
                act["trigger"] = _text(a.get("trigger"), 39)
            elif d == "counter":
                act["counter"] = _text(a.get("counter"), 39)
                act["op"] = "set" if a.get("op") == "set" else "add"
                act["value"] = int(max(-9999, min(9999, _num(a.get("value"), 1))))
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
            elif d == "win":
                act["team"] = a.get("team") if a.get("team") in ("team1", "team2", "draw") else "team1"
                act["text"] = _text(a.get("text"), 190)
            else:
                act["text"] = _text(a.get("text"), 190)
            acts.append(act)
        out["triggers"].append({
            "id": _text(t.get("id"), 39), "name": _text(t.get("name"), 47), "when": when,
            "area": _text(t.get("area"), 39), "group": _text(t.get("group"), 39), "trigger": _text(t.get("trigger"), 39),
            "seconds": round(max(0, min(3600, _num(t.get("seconds"), 0))), 1),
            "count": int(max(-9999, min(9999, _num(t.get("count"), 0)))),
            "counter": _text(t.get("counter"), 39),
            "compare": t.get("compare") if t.get("compare") in (">=", "==", "<=") else ">=",
            "startOff": bool(t.get("startOff")),
            "repeat": bool(t.get("repeat")), "cooldown": round(max(1, min(3600, _num(t.get("cooldown"), 5))), 1),
            "actions": acts,
        })
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
        })
    return out


# --- NPC types -> the game's NPC folder --------------------------------------
#
# MBII reads ext_data/NPCs/*.npc when a map loads. Every scenario's own types
# go into one file there, holotable.npc, rewritten on each save - so a new
# or changed type can be spawned after the server's next map change.

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
        lines.append("\tsaber\t\tsingle_1")
        lines.append("\tsaberColor\t{}".format(n["saberColor"]))
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
        "\tplayerTeam\tTEAM_FREE",
        "\tenemyTeam\tTEAM_PLAYER",
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


def save(sid, data, author):
    cleaned = clean(data)
    with _lock:
        try:
            old = load(sid)
        except FileNotFoundError:
            old = {}
        cleaned["created"] = old.get("created", int(time.time()))
        cleaned["createdBy"] = old.get("createdBy", author)
        cleaned["owner"] = owner_of(old) or author
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
