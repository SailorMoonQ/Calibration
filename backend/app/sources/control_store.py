"""Per-camera control values and named presets, persisted to disk.

Knows nothing about V4L2 — it stores `{control_name: int}` maps and hands them
back. Talking to the driver is `v4l2_controls`' job; wiring the two together at
stream-open time is `opencv`'s.

Cameras are keyed by USB serial rather than by /dev/videoN, because the device
path changes on re-plug (or when another camera enumerates first) while the
serial does not. A camera with no readable serial falls back to its path, and the
record is tagged `keyed_by: "path"` so the ambiguity is visible later rather than
silently producing a mismatched preset.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path

log = logging.getLogger("calib.controls")

# Same root the voice assets already use (see app/voice.py).
_ROOT = Path.home() / ".calibration-workbench"
_PATH = _ROOT / "camera-controls.json"

SCHEMA_VERSION = 1

_lock = threading.Lock()


def _empty() -> dict:
    return {"version": SCHEMA_VERSION, "devices": {}}


def _path() -> Path:
    """Indirection so tests can redirect the store via CALIB_CONTROL_STORE."""
    override = os.environ.get("CALIB_CONTROL_STORE")
    return Path(override) if override else _PATH


def load() -> dict:
    """Read the store. A missing, empty, or corrupt file yields a fresh store
    rather than raising — a broken config must not stop the camera from opening."""
    p = _path()
    try:
        if not p.exists():
            return _empty()
        data = json.loads(p.read_text() or "{}")
    except Exception as e:
        log.warning("camera-controls.json unreadable (%s); starting fresh", e)
        return _empty()
    if not isinstance(data, dict) or "devices" not in data:
        return _empty()
    data.setdefault("version", SCHEMA_VERSION)
    if not isinstance(data.get("devices"), dict):
        data["devices"] = {}
    return data


def save(data: dict) -> None:
    """Atomic write: a crash mid-write must leave the previous config intact,
    not a truncated file that then reads as 'no presets'."""
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".camera-controls-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def device_key(device: str, serial: str | None) -> tuple[str, str]:
    """(key, keyed_by). Serial when available, else the device path."""
    if serial:
        return serial, "serial"
    return device, "path"


def _entry(data: dict, key: str, keyed_by: str) -> dict:
    entry = data["devices"].get(key)
    if not isinstance(entry, dict):
        entry = {"keyed_by": keyed_by, "active": None, "presets": {}}
        data["devices"][key] = entry
    entry.setdefault("keyed_by", keyed_by)
    entry.setdefault("active", None)
    if not isinstance(entry.get("presets"), dict):
        entry["presets"] = {}
    return entry


def list_presets(key: str) -> dict:
    data = load()
    entry = data["devices"].get(key)
    if not isinstance(entry, dict):
        return {"active": None, "presets": {}}
    presets = entry.get("presets")
    return {
        "active": entry.get("active"),
        "presets": presets if isinstance(presets, dict) else {},
    }


def active_controls(key: str) -> dict[str, int] | None:
    """The control values of the currently active preset, or None when the user
    has never chosen one. None is meaningful: it tells the open path to keep the
    legacy force-auto-exposure behaviour instead of replaying user intent."""
    info = list_presets(key)
    name = info["active"]
    if not name:
        return None
    values = info["presets"].get(name)
    if not isinstance(values, dict) or not values:
        return None
    return {k: int(v) for k, v in values.items() if isinstance(v, (int, float))}


def save_preset(key: str, keyed_by: str, name: str, values: dict[str, int]) -> dict:
    """Create or overwrite a preset and make it active — saving a preset you are
    currently tuning and NOT having it apply would be surprising."""
    if not name or not name.strip():
        raise ValueError("preset name required")
    name = name.strip()
    with _lock:
        data = load()
        entry = _entry(data, key, keyed_by)
        entry["presets"][name] = {k: int(v) for k, v in values.items()}
        entry["active"] = name
        save(data)
    return list_presets(key)


def delete_preset(key: str, name: str) -> dict:
    with _lock:
        data = load()
        entry = data["devices"].get(key)
        if isinstance(entry, dict) and isinstance(entry.get("presets"), dict):
            entry["presets"].pop(name, None)
            if entry.get("active") == name:
                entry["active"] = None
            save(data)
    return list_presets(key)


def set_active(key: str, keyed_by: str, name: str | None) -> dict:
    """Switch the active preset. `None` clears it, which restores the legacy
    force-auto-exposure behaviour on the next stream open."""
    with _lock:
        data = load()
        entry = _entry(data, key, keyed_by)
        if name is not None and name not in entry["presets"]:
            raise KeyError(name)
        entry["active"] = name
        save(data)
    return list_presets(key)


# Name given to the preset that live slider edits land in when the user has not
# created a named one. It behaves like any other preset (renameable by saving
# under a new name) — it exists so that "what you set is what you get back" holds
# without forcing everyone to think about presets first.
IMPLICIT_PRESET = "当前"


def remember_value(key: str, keyed_by: str, name: str, value: int) -> dict:
    """Record one live control edit into the active preset.

    Creates and activates IMPLICIT_PRESET when nothing is active, so an edit made
    by someone who never opened the preset UI still survives a stream restart."""
    with _lock:
        data = load()
        entry = _entry(data, key, keyed_by)
        active = entry.get("active")
        if not active or active not in entry["presets"]:
            active = IMPLICIT_PRESET
            entry["presets"].setdefault(active, {})
            entry["active"] = active
        entry["presets"][active][name] = int(value)
        save(data)
    return list_presets(key)
