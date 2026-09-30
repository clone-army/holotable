"""Holotable's own accounts: data/users.json, passwords hashed.

The first time it runs with no accounts, it makes one from HT_ADMIN_USER /
HT_ADMIN_PASSWORD in .env. Roles: "admin" (can manage accounts) and
"editor" (can build scenarios).

An account can also be linked to its owner's in-game account (the handle
they !login with) and allowed to run scenarios in game (!ht play, restart,
stop) without being a game admin: those handles are kept in
GAMEDATA/holotable_runners.dat, which the servers re-read every few seconds.
"""
import json
import os
import threading

from werkzeug.security import check_password_hash, generate_password_hash

from . import config

ROLES = ("admin", "editor")
_lock = threading.Lock()


def _path():
    return os.path.join(config.DATA_DIR, "users.json")


def _load():
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, ValueError):
        return []


def _save(users):
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = _path() + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2)
    os.replace(tmp, _path())


def bootstrap():
    """Make the .env admin if there are no accounts yet. Returns a warning
    to print, or None."""
    with _lock:
        if _load():
            return None
        if not config.ADMIN_PASSWORD:
            return "No accounts yet and HT_ADMIN_PASSWORD isn't set in .env - nobody can log in."
        _save([{"username": config.ADMIN_USER, "password": generate_password_hash(config.ADMIN_PASSWORD), "role": "admin"}])
        return None


def check(username, password):
    """The account's role if the password's right, else None."""
    for u in _load():
        if u.get("username", "").lower() == str(username or "").strip().lower():
            if check_password_hash(u.get("password", ""), str(password or "")):
                return u.get("role", "editor")
            return None
    return None


def role_of(username):
    for u in _load():
        if u.get("username", "").lower() == str(username or "").lower():
            return u.get("role", "editor")
    return None


def listing():
    return [{"username": u.get("username", ""), "role": u.get("role", "editor"),
             "handle": u.get("handle", ""), "can_run": bool(u.get("can_run"))} for u in _load()]


RUNNERS_FILE = "holotable_runners.dat"


def game_handles():
    """Every in-game account handle (from the shared accounts file)."""
    out = []
    try:
        with open(os.path.join(config.GAMEDATA, "economy_accounts.dat"), "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                parts = line.split()
                if len(parts) == 6:
                    out.append(parts[0])
    except FileNotFoundError:
        pass
    return sorted(out, key=str.lower)


def _write_runners(users):
    handles = sorted({u["handle"] for u in users if u.get("can_run") and u.get("handle")}, key=str.lower)
    path = os.path.join(config.GAMEDATA, RUNNERS_FILE)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("".join(h + "\n" for h in handles))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def set_game_link(username, handle=None, can_run=None):
    """Links an account to an in-game handle and/or lets it run scenarios."""
    with _lock:
        users = _load()
        target = next((u for u in users if u.get("username", "").lower() == str(username).lower()), None)
        if not target:
            return False, "No such user."
        if handle is not None:
            handle = str(handle).strip()
            if handle and (len(handle) > 23 or not all(c.isalnum() or c == "_" for c in handle)):
                return False, "In-game handles are up to 23 letters, numbers or _."
            known = {h.lower(): h for h in game_handles()}
            if handle and handle.lower() not in known:
                return False, "There's no in-game account called '{}' - they need to !register it first.".format(handle)
            if handle and any(u is not target and u.get("handle", "").lower() == handle.lower() for u in users):
                return False, "Another Holotable account is already linked to {}.".format(handle)
            target["handle"] = known.get(handle.lower(), handle) if handle else ""
        if can_run is not None:
            target["can_run"] = bool(can_run)
        _save(users)
        _write_runners(users)
    msg = "Saved."
    if target.get("can_run") and not target.get("handle"):
        msg = "Saved - link their in-game account too, or they can't run scenarios in game."
    return True, msg


def _valid_name(name):
    return 3 <= len(name) <= 32 and all(c.isalnum() or c in "_-." for c in name)


def add(username, password, role):
    username = str(username or "").strip()
    if not _valid_name(username):
        return False, "Usernames are 3-32 letters, numbers, _ - or ."
    if len(str(password or "")) < 8:
        return False, "Passwords need at least 8 characters."
    if role not in ROLES:
        return False, "Unknown role."
    with _lock:
        users = _load()
        if any(u.get("username", "").lower() == username.lower() for u in users):
            return False, "That username's taken."
        users.append({"username": username, "password": generate_password_hash(password), "role": role})
        _save(users)
    return True, "Added {}.".format(username)


def set_password(username, password):
    if len(str(password or "")) < 8:
        return False, "Passwords need at least 8 characters."
    with _lock:
        users = _load()
        for u in users:
            if u.get("username", "").lower() == str(username).lower():
                u["password"] = generate_password_hash(password)
                _save(users)
                return True, "Password changed."
    return False, "No such user."


def set_role(username, role):
    if role not in ROLES:
        return False, "Unknown role."
    with _lock:
        users = _load()
        target = next((u for u in users if u.get("username", "").lower() == str(username).lower()), None)
        if not target:
            return False, "No such user."
        if target.get("role") == "admin" and role != "admin" and sum(u.get("role") == "admin" for u in users) <= 1:
            return False, "There has to be at least one admin."
        target["role"] = role
        _save(users)
    return True, "Role changed."


def delete(username):
    with _lock:
        users = _load()
        target = next((u for u in users if u.get("username", "").lower() == str(username).lower()), None)
        if not target:
            return False, "No such user."
        if target.get("role") == "admin" and sum(u.get("role") == "admin" for u in users) <= 1:
            return False, "There has to be at least one admin."
        users.remove(target)
        _save(users)
        _write_runners(users)
    return True, "Deleted {}.".format(username)
