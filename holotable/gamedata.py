"""What's in the game folder: its maps (from the pk3s, or loose .bsp files)
and NPC types, and a top-down map of any of them.

The top-down geometry comes straight from the map's .bsp (JKA's RBSP
format): its drawn surfaces, split into floors (facing up - drawn from
above) and walls (upright - drawn as lines), with the heights of its
storeys worked out from where the floor area piles up. Worked out once per
map and cached in the data folder.
"""
import gzip
import json
import math
import os
import re
import struct
import threading
import zipfile

from . import config

_lock = threading.Lock()
_index = {"sig": None, "maps": {}, "npcs": None}

# Surfaces never drawn (sky, tool textures, effects).
_SKIP_SHADERS = ("sky", "nodraw", "clip", "caulk", "trigger", "hint", "skip", "fog", "water",
                 "volumetric", "flare", "shadow", "areaportal", "origin", "system/")
# Liquids and fog (CONTENTS_LAVA, _SLIME, _WATER, _FOG) aren't floors. Other
# non-solid surfaces are kept: a floor you see is often a non-solid shader
# (shiny, translucent, decal) over a collision brush that isn't drawn.
_CONTENTS_LIQUID = 0x2 | 0x4 | 0x8 | 0x10
_GEOMETRY_VERSION = 7


def _pk3s():
    try:
        names = [f for f in os.listdir(config.GAMEDATA) if f.lower().endswith(".pk3")]
    except FileNotFoundError:
        return []
    # The game reads pk3s in name order and a later one wins.
    return sorted(names, key=lambda n: n.lower())


def _signature():
    sig = []
    for name in _pk3s():
        try:
            st = os.stat(os.path.join(config.GAMEDATA, name))
            sig.append((name, st.st_size, int(st.st_mtime)))
        except OSError:
            pass
    loose = os.path.join(config.GAMEDATA, "maps")
    if os.path.isdir(loose):
        sig.append(("maps", tuple(sorted(os.listdir(loose)))))
    return tuple(sig)


def _refresh():
    sig = _signature()
    if _index["sig"] == sig:
        return
    maps = {}
    for name in _pk3s():
        path = os.path.join(config.GAMEDATA, name)
        try:
            with zipfile.ZipFile(path) as z:
                for info in z.infolist():
                    low = info.filename.lower()
                    if low.startswith("maps/") and low.endswith(".bsp") and low.count("/") == 1:
                        mapname = info.filename[5:-4]
                        maps[mapname.lower()] = {"name": mapname, "pk3": path, "member": info.filename,
                                                 "size": info.file_size, "stamp": info.date_time}
        except (zipfile.BadZipFile, OSError):
            continue
    loose = os.path.join(config.GAMEDATA, "maps")
    if os.path.isdir(loose):
        for f in os.listdir(loose):
            if f.lower().endswith(".bsp"):
                p = os.path.join(loose, f)
                maps[f[:-4].lower()] = {"name": f[:-4], "file": p, "size": os.path.getsize(p),
                                        "stamp": int(os.path.getmtime(p))}
    _index["maps"] = maps
    _index["npcs"] = None
    _index["sig"] = sig


def list_maps():
    with _lock:
        _refresh()
        return sorted((m["name"] for m in _index["maps"].values()), key=str.lower)


def find_map(name):
    with _lock:
        _refresh()
        return _index["maps"].get(str(name or "").lower())


def _read_bsp(entry):
    if "file" in entry:
        with open(entry["file"], "rb") as f:
            return f.read()
    with zipfile.ZipFile(entry["pk3"]) as z:
        return z.read(entry["member"])


def _normal_z(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    ln = math.sqrt(nx * nx + ny * ny + nz * nz)
    return (nz / ln) if ln else 0.0, ln * 0.5


def _levels(floor_areas):
    """Likely storey heights, as presets for the editor's cut-height slider:
    where the floor area piles up (32-unit buckets), biggest first, at
    least 128 units apart, then bottom to top. Rooftops pile up too - the
    slider covers whatever these miss."""
    buckets = {}
    total = 0.0
    for z, area in floor_areas:
        k = int(math.floor(z / 32.0))
        buckets[k] = buckets.get(k, 0.0) + area
        total += area
    if not total:
        return []
    chosen = []
    for k, area in sorted(buckets.items(), key=lambda kv: -kv[1]):
        if area < total * 0.012 or len(chosen) >= 12:
            break
        z = k * 32 + 16
        if all(abs(z - c) >= 128 for c in chosen):
            chosen.append(z)
    return sorted(chosen)


def _extract(data):
    if data[:4] != b"RBSP":
        raise ValueError("not a JKA map (RBSP) - {}".format(data[:4]))

    def lump(i):
        return struct.unpack_from("<ii", data, 8 + i * 8)

    so, sl = lump(1)
    shaders = []
    for i in range(sl // 72):
        name = data[so + i * 72: so + i * 72 + 64].split(b"\0")[0].decode("latin1").lower()
        _sflags, cflags = struct.unpack_from("<ii", data, so + i * 72 + 64)
        shaders.append(not any(s in name for s in _SKIP_SHADERS) and not (cflags & _CONTENTS_LIQUID))

    vo, vl = lump(10)
    # x, y, z and the surface normal's z: which way a surface faces comes
    # from the normals stored with it - Q3 maps wind triangles clockwise, so
    # working it out from the corner order gets it upside down.
    verts = [(v[0], v[1], v[2], v[5]) for v in struct.iter_unpack("<3f8x32x3f16x", data[vo: vo + (vl // 80) * 80])]
    io, il = lump(11)
    idx = struct.unpack_from("<%di" % (il // 4), data, io)
    fo, fl = lump(13)

    floors, walls, floor_areas = [], set(), []

    def add(a, b, c):
        _nz, area = _normal_z(a, b, c)
        if area < 1.0:
            return
        nz = (a[3] + b[3] + c[3]) / 3.0
        if nz > 0.6:
            floors.append((a, b, c))
            floor_areas.append(((a[2] + b[2] + c[2]) / 3.0, area))
        elif abs(nz) < 0.35:
            # Upright: the longest edge seen from above, and its heights.
            pts = (a, b, c)
            best, seg = -1.0, None
            for i in range(3):
                for j in range(i + 1, 3):
                    d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2
                    if d > best:
                        best, seg = d, (pts[i], pts[j])
            if best < 4.0:
                return
            zs = (a[2], b[2], c[2])
            p, q = seg
            key = (round(p[0]), round(p[1]), round(q[0]), round(q[1]), round(min(zs)), round(max(zs)))
            if (key[2], key[3], key[0], key[1], key[4], key[5]) not in walls:
                walls.add(key)

    for i in range(fl // 148):
        base = fo + i * 148
        shader, _fog, stype, fv, nv, fi, ni = struct.unpack_from("<7i", data, base)
        if shader < 0 or shader >= len(shaders) or not shaders[shader]:
            continue
        if stype in (1, 3):
            for t in range(0, ni - 2, 3):
                add(verts[fv + idx[fi + t]], verts[fv + idx[fi + t + 1]], verts[fv + idx[fi + t + 2]])
        elif stype == 2:
            pw, ph = struct.unpack_from("<2i", data, base + 140)
            for y in range(ph - 1):
                for x in range(pw - 1):
                    a, b = verts[fv + y * pw + x], verts[fv + y * pw + x + 1]
                    c, e = verts[fv + (y + 1) * pw + x], verts[fv + (y + 1) * pw + x + 1]
                    add(a, b, e)
                    add(a, e, c)

    # Where players spawn (info_player_*): shown on the map, and where the
    # editor first sets its cut height - that's the floor people play on.
    eo, el = lump(0)
    ents = data[eo: eo + el].decode("latin1", "replace")
    spawns = []
    for block in re.findall(r"\{[^{}]*\}", ents):
        cls = re.search(r'"classname"\s+"(info_player_\w+)"', block)
        org = re.search(r'"origin"\s+"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"', block)
        if cls and org:
            spawns.append([round(float(org.group(i))) for i in (1, 2, 3)])
    zs = sorted(p[2] for p in spawns)

    flat = []
    for t in floors:
        for p in t:
            flat += (round(p[0]), round(p[1]), round(p[2]))
    xs = flat[0::3] or [0]
    ys = flat[1::3] or [0]
    return {
        "version": _GEOMETRY_VERSION,
        "bounds": [min(xs), min(ys), max(xs), max(ys)],
        "floors": flat,                                   # x,y,z x3 per triangle
        "walls": [v for w in sorted(walls) for v in w],   # x1,y1,x2,y2,zmin,zmax per wall
        "levels": _levels(floor_areas),
        "spawns": [v for p in spawns[:256] for v in p],    # x,y,z per player spawn
        "spawnZ": zs[len(zs) // 2] if zs else None,       # the middle one's height
    }


def geometry_json(mapname):
    """The map's top-down geometry as (gzipped) JSON bytes, or None."""
    entry = find_map(mapname)
    if not entry:
        return None
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    stamp = "{}-{}-{}".format(entry["size"], re.sub(r"\W", "", str(entry["stamp"])), _GEOMETRY_VERSION)
    path = os.path.join(config.CACHE_DIR, "{}.{}.json.gz".format(entry["name"].lower(), stamp))
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    geo = _extract(_read_bsp(entry))
    geo["map"] = entry["name"]
    blob = gzip.compress(json.dumps(geo, separators=(",", ":")).encode(), 6)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(blob)
    os.replace(tmp, path)
    return blob


# --- NPC types ------------------------------------------------------------

_NPC_BLOCK = re.compile(r"([A-Za-z0-9_\-]+)\s*\{")


def _parse_npcs(text, out):
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    i = 0
    while True:
        m = _NPC_BLOCK.search(text, i)
        if not m:
            break
        depth, j = 0, m.end() - 1
        while j < len(text):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = text[m.end(): j]
        name = m.group(1)
        # Vehicles are refused as NPCs; skip them.
        if not re.search(r"CLASS_VEHICLE", body, re.I) and name.lower() not in ("npc", "vehicle"):
            model = re.search(r"playerModel\s+\"?([\w\-/]+)", body)
            out[name.lower()] = {"name": name, "model": model.group(1) if model else ""}
        i = j + 1


def list_npcs():
    with _lock:
        _refresh()
        if _index["npcs"] is not None:
            return _index["npcs"]
        out = {}
        for name in _pk3s():
            try:
                with zipfile.ZipFile(os.path.join(config.GAMEDATA, name)) as z:
                    for info in z.infolist():
                        low = info.filename.lower()
                        if low.startswith("ext_data/npcs/") and low.endswith(".npc"):
                            _parse_npcs(z.read(info.filename).decode("latin1"), out)
            except (zipfile.BadZipFile, OSError):
                continue
        for d in [os.path.join(config.GAMEDATA, "ext_data", "NPCs"), os.path.join(config.GAMEDATA, "ext_data", "npcs")] + config.EXTRA_NPC_DIRS:
            if os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    if f.lower().endswith(".npc"):
                        with open(os.path.join(d, f), "r", encoding="latin1") as fh:
                            _parse_npcs(fh.read(), out)
        _index["npcs"] = sorted(out.values(), key=lambda n: n["name"].lower())
        return _index["npcs"]


# --- Models, skins, sounds ----------------------------------------------------
#
# One pass over the pk3s (later ones win, as in game): every player model's
# skins (models/players/<model>/model_<skin>.skin), their icons, and every
# sound file - for the NPC builder's pickers and the sound search.

_assets = {"sig": None}
_ICON_EXT = (".jpg", ".jpeg", ".png")


def _assets_index():
    with _lock:
        _refresh()
        if _assets.get("sig") == _index["sig"]:
            return _assets
        skins, icons, sounds = {}, {}, {}
        for name in _pk3s():
            path = os.path.join(config.GAMEDATA, name)
            try:
                with zipfile.ZipFile(path) as z:
                    for member in z.namelist():
                        low = member.lower()
                        if low.startswith("models/players/"):
                            parts = member.split("/")
                            if len(parts) != 4:
                                continue
                            model, fname = parts[2], parts[3]
                            fl = fname.lower()
                            if fl.startswith("model_") and fl.endswith(".skin"):
                                skins.setdefault(model.lower(), {"model": model, "skins": set()})["skins"].add(fname[6:-5])
                            elif fl.endswith(_ICON_EXT) and ("icon_" in fl):
                                skin = re.sub(r"^(mb2_)?icon_", "", fname.rsplit(".", 1)[0], flags=re.I)
                                icons[(model.lower(), skin.lower())] = (path, member)
                        elif low.startswith("sound/") and low.endswith((".mp3", ".wav")):
                            sounds[low] = (path, member)
            except (zipfile.BadZipFile, OSError):
                continue
        _assets.update(sig=_index["sig"], skins=skins, icons=icons, sounds=sounds,
                       sound_list=sorted(sounds))
        return _assets


def list_models():
    a = _assets_index()
    out = []
    for key in sorted(a["skins"]):
        m = a["skins"][key]
        out.append({"model": m["model"], "skins": sorted(m["skins"], key=str.lower)})
    return out


def model_icon(model, skin):
    """(bytes, mimetype) of a model/skin's icon, if the game has one we can show."""
    a = _assets_index()
    m = str(model).lower()
    hit = a["icons"].get((m, str(skin).lower())) or a["icons"].get((m, "default"))
    if not hit:
        # Any icon of that model, rather than none.
        hit = next((v for (im, _s), v in a["icons"].items() if im == m), None)
    if not hit:
        return None
    with zipfile.ZipFile(hit[0]) as z:
        data = z.read(hit[1])
    ext = hit[1].lower().rsplit(".", 1)[-1]
    return data, ("image/png" if ext == "png" else "image/jpeg")


def search_sounds(query, limit=60):
    a = _assets_index()
    words = [w for w in str(query or "").lower().replace("\\", "/").split() if w]
    if not words:
        return []
    out = []
    for s in a["sound_list"]:
        if all(w in s for w in words):
            out.append(s)
            if len(out) >= limit:
                break
    return out


def sound_file(path):
    """(bytes, mimetype) of a sound, for previewing in the browser."""
    a = _assets_index()
    hit = a["sounds"].get(str(path or "").lower().replace("\\", "/"))
    if not hit:
        return None
    with zipfile.ZipFile(hit[0]) as z:
        data = z.read(hit[1])
    return data, ("audio/mpeg" if hit[1].lower().endswith(".mp3") else "audio/wav")


# Weapons NPCs can carry (MBII's WP_ names, as its own .npc files use them).
WEAPONS = [
    "WP_MELEE", "WP_STUN_BATON", "WP_SABER",
    "WP_BRYAR_PISTOL", "WP_BRYAR_OLD", "WP_BLASTER_PISTOL", "WP_HEAVY_PISTOL", "WP_CLONE_PISTOL", "WP_MANDO_PISTOL",
    "WP_BLASTER", "WP_E_22", "WP_A280", "WP_DLT19", "WP_DLT20A", "WP_T21", "WP_EE3", "WP_EE4", "WP_CR2", "WP_M5",
    "WP_CLONE_RIFLE", "WP_DC_CARBINE", "WP_SBD", "WP_PROJ", "WP_AMBAN",
    "WP_REPEATER", "WP_MINIGUN", "WP_FLECHETTE", "WP_SHOTGUN", "WP_BOWCASTER", "WP_TRAD_BOWCASTER",
    "WP_DISRUPTOR", "WP_DEMP2", "WP_CONCUSSION", "WP_PLX1", "WP_ROCKET_LAUNCHER", "WP_THROWER",
    "WP_THERMAL", "WP_FRAG_NADE", "WP_CONC_NADE", "WP_CRYO_NADE", "WP_FIRE_NADE", "WP_PULSE_NADE", "WP_SONIC_NADE", "WP_REAL_TD",
]
