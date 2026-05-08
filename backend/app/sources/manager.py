"""Singleton registry of image sources keyed by an opaque string. /dev/video* keys
go to CameraSource (USB); ros2:<topic> keys go to Ros2ImageSource. Refcount-aware
start/stop so multiple consumers share one capture."""
from __future__ import annotations

import glob
import logging
import threading

from app.sources.opencv import CameraSource

log = logging.getLogger("calib.source.mgr")

_sources: dict = {}
_lock = threading.Lock()

ROS2_PREFIX = "ros2:"


def get(key: str):
    with _lock:
        src = _sources.get(key)
        if src is None:
            if key.startswith(ROS2_PREFIX):
                # Lazy import keeps rclpy out of the boot path; surfaces the
                # rclpy-missing error only when the user actually picks ros2.
                from app.sources.ros2 import Ros2ImageSource
                src = Ros2ImageSource(key[len(ROS2_PREFIX):])
            else:
                src = CameraSource(key)
            _sources[key] = src
    src.start()
    return src


def release(key: str) -> None:
    with _lock:
        src = _sources.get(key)
    if src:
        src.stop()


def list_devices() -> list[dict]:
    """USB cameras only — ROS2 topic listing is a separate endpoint so the
    renderer doesn't have to disambiguate transports at every call site."""
    paths = sorted(glob.glob("/dev/video*"))
    return [{"device": p, "label": p} for p in paths]


def shutdown_all() -> None:
    with _lock:
        items = list(_sources.items())
        _sources.clear()
    for _key, src in items:
        src._refs = 1  # force a single decrement to close
        src.stop()
    # Tear down the rclpy context if it was ever started. Safe to call when
    # never started (the module checks _started internally).
    try:
        from app.sources import ros2_context
        ros2_context.shutdown()
    except ImportError:
        pass
