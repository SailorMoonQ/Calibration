"""Ref-counted registry of PoseSource instances keyed by source name. Mirrors
sources/manager.py for camera sources. Multiple consumers (e.g. HandEye tab +
LinkCalib tab + telemetry pill) share one underlying client; the source is
torn down only when the last consumer releases it."""
from __future__ import annotations

import logging
import threading
from typing import Callable

from app.sources.poses import PoseSource
from app.sources.poses.mock import MockPoseSource

log = logging.getLogger("calib.pose.mgr")

_sources: dict[str, PoseSource] = {}
_refs: dict[str, int] = {}
_lock = threading.Lock()


def _build_oculus(**kw) -> PoseSource:
    # Lazy import — keeps the vendored submodule + adb client out of the boot path.
    from app.sources.poses.oculus import OculusPoseSource
    return OculusPoseSource(ip_address=kw.get("ip"))


def _build_steamvr(**kw) -> PoseSource:
    from app.sources.poses.steamvr import SteamVRPoseSource
    return SteamVRPoseSource()


_BUILDERS: dict[str, Callable[..., PoseSource]] = {
    "mock":    lambda **kw: MockPoseSource(),
    "oculus":  _build_oculus,
    "steamvr": _build_steamvr,
}


def get(key: str, *, ip: str | None = None) -> PoseSource:
    """Acquire a refcount on the named source. First acquire constructs it
    (passing `ip` to oculus); subsequent acquires share the existing instance
    and ignore `ip` — only the first caller's connection params apply.
    """
    with _lock:
        src = _sources.get(key)
        if src is None:
            builder = _BUILDERS.get(key)
            if builder is None:
                raise ValueError(f"unknown pose source: {key!r}")
            src = builder(ip=ip)
            _sources[key] = src
            _refs[key] = 0
        _refs[key] += 1
    return src


def release(key: str) -> None:
    """Drop a refcount; close and forget the source when it reaches zero."""
    with _lock:
        if key not in _refs:
            return
        _refs[key] -= 1
        if _refs[key] > 0:
            return
        src = _sources.pop(key, None)
        _refs.pop(key, None)
    if src is not None:
        try:
            src.close()
        except Exception:  # pragma: no cover — best-effort teardown
            log.exception("pose source close failed: %s", key)


def shutdown_all() -> None:
    """Forcefully close every live source. Called on app shutdown."""
    with _lock:
        items = list(_sources.items())
        _sources.clear()
        _refs.clear()
    for key, src in items:
        try: src.close()
        except Exception: log.exception("pose source close failed: %s", key)
