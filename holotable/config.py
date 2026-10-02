"""Settings, from .env beside app.py (then the real environment)."""
import os
import secrets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env(path):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
    except FileNotFoundError:
        pass
    return values


ENV_FILE = os.path.join(ROOT, ".env")
_env = _load_env(ENV_FILE)


def get(key, default=""):
    return os.environ.get(key, _env.get(key, default))


def _path(value):
    return value if os.path.isabs(value) else os.path.normpath(os.path.join(ROOT, value))


# The game's own folder (fs_basepath/fs_game) - its pk3s give the maps and
# NPC types, and scenarios are saved in its holotable/ folder, where the
# engine looks for them.
GAMEDATA = _path(get("GAMEDATA", "/opt/openjk/MBII"))
SCENARIO_DIR = _path(get("HT_SCENARIO_DIR", "") or os.path.join(GAMEDATA, "holotable"))
# Base Jedi Academy's folder (its assets*.pk3) - props come from there too.
BASEDATA = _path(get("HT_BASEDATA", "") or os.path.join(os.path.dirname(GAMEDATA.rstrip("/")), "base"))
DATA_DIR = _path(get("HT_DATA_DIR", "data"))
CACHE_DIR = os.path.join(DATA_DIR, "cache")
# More folders of loose .npc files (colon separated) - e.g. an instance's
# homepath ext_data/NPCs, where servers write their own NPC types.
EXTRA_NPC_DIRS = [_path(p) for p in get("HT_EXTRA_NPC_DIRS", "").split(":") if p.strip()]

HOST = get("HT_HOST", "0.0.0.0")
PORT = int(get("HT_PORT", "8090") or 8090)
ADMIN_USER = get("HT_ADMIN_USER", "admin")
ADMIN_PASSWORD = get("HT_ADMIN_PASSWORD", "")


def secret_key():
    """HT_SECRET_KEY, or one made up and kept in the data folder."""
    key = get("HT_SECRET_KEY", "")
    if key:
        return key
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, "secret.key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
    except FileNotFoundError:
        key = ""
    if not key:
        key = secrets.token_hex(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(key)
    return key
