"""Holotable's own accounts: data/users.json, passwords hashed.

The first time it runs with no accounts, it makes one from HT_ADMIN_USER /
HT_ADMIN_PASSWORD in .env. Roles: "admin" (can manage accounts) and
"editor" (can build scenarios).
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
    return [{"username": u.get("username", ""), "role": u.get("role", "editor")} for u in _load()]


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
    return True, "Deleted {}.".format(username)
