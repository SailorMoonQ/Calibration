"""Per-camera ROI (crop window), persisted to disk.

Same shape and same identity rules as `control_store`: keyed by USB serial so it
survives re-plug, atomic writes so a crash cannot leave a truncated file, and a
corrupt file degrades to "no ROI" rather than stopping the camera from opening.

Kept as its own module rather than a field inside control_store because the two
have different lifecycles — controls are tuned continuously during a session, an
ROI is set once before calibration and then left alone.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path

log = logging.getLogger("calib.roi")

_ROOT = Path.home() / ".calibration-workbench"
_PATH = _ROOT / "camera-roi.json"

SCHEMA_VERSION = 1

_lock = threading.Lock()


def _path() -> Path:
    override = os.environ.get("CALIB_ROI_STORE")
    return Path(override) if override else _PATH


def _empty() -> dict:
    return {"version": SCHEMA_VERSION, "devices": {}}


def load() -> dict:
    p = _path()
    try:
        if not p.exists():
            return _empty()
        data = json.loads(p.read_text() or "{}")
    except Exception as e:
        log.warning("camera-roi.json unreadable (%s); starting fresh", e)
        return _empty()
    if not isinstance(data, dict) or not isinstance(data.get("devices"), dict):
        return _empty()
    data.setdefault("version", SCHEMA_VERSION)
    return data


def save(data: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".camera-roi-", suffix=".tmp")
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


def get_roi(key: str) -> dict | None:
    """The stored ROI, or None. A record missing any field or carrying a
    non-positive size reads as None — a half-written ROI must not become a crop
    nobody asked for."""
    entry = load()["devices"].get(key)
    if not isinstance(entry, dict):
        return None
    try:
        roi = {k: int(entry[k]) for k in ("left", "top", "width", "height")}
    except (KeyError, TypeError, ValueError):
        return None
    if roi["width"] <= 0 or roi["height"] <= 0:
        return None
    if roi["left"] < 0 or roi["top"] < 0:
        return None
    return roi


def set_roi(key: str, keyed_by: str, roi: dict | None) -> dict | None:
    with _lock:
        data = load()
        if roi is None:
            data["devices"].pop(key, None)
        else:
            data["devices"][key] = {
                "keyed_by": keyed_by,
                "left": int(roi["left"]), "top": int(roi["top"]),
                "width": int(roi["width"]), "height": int(roi["height"]),
            }
        save(data)
    return get_roi(key)
