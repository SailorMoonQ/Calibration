"""Singleton registry of CameraSources keyed by device path. Handles refcounted start/stop
so multiple concurrent consumers (live MJPEG + snap + eventual detection thread) share one capture."""
from __future__ import annotations

import glob
import logging
import threading

from app.sources.opencv import CameraSource

log = logging.getLogger("calib.source.mgr")

_sources: dict[str, CameraSource] = {}
_lock = threading.Lock()


def get(device: str) -> CameraSource:
    with _lock:
        src = _sources.get(device)
        if src is None:
            src = CameraSource(device)
            _sources[device] = src
    src.start()
    return src


def release(device: str) -> None:
    with _lock:
        src = _sources.get(device)
    if src:
        src.stop()


def list_devices() -> list[dict]:
    """Enumerate /dev/video* without opening them (opening probes is slow and can conflict)."""
    paths = sorted(glob.glob("/dev/video*"))
    return [{"device": p, "label": p} for p in paths]


def shutdown_all() -> None:
    with _lock:
        items = list(_sources.items())
        _sources.clear()
    for _dev, src in items:
        src._refs = 1  # force a single decrement to close
        src.stop()
