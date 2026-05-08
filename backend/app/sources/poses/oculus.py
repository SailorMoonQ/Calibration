"""Quest3(s) pose source via OculusReader (rail-berkeley/oculus_reader).

The submodule lives at <repo>/third_party/oculus_reader. We add it to sys.path
on import so backend installs don't need a pip-editable step. OculusReader's
APK emits only the two controllers ('r' and 'l') — no HMD pose — so this source
exposes exactly `quest_ctrl_l` and `quest_ctrl_r`.

OculusReader spawns its own daemon logcat thread internally and exposes the
last transforms via a thread-safe getter, so we don't need an extra grabber
thread here — `poll()` just reads the latest slot.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import numpy as np

from app.sources.poses import PoseSource

log = logging.getLogger("calib.source.oculus")

# Submodule on disk — adjust once if the repo layout moves.
_VENDOR = Path(__file__).resolve().parents[4] / "third_party" / "oculus_reader"
if str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))


DEVICES = ["quest_ctrl_l", "quest_ctrl_r"]
_CHAR_TO_DEV = {"l": "quest_ctrl_l", "r": "quest_ctrl_r"}


class OculusPoseSource(PoseSource):
    def __init__(self, ip_address: str | None = None) -> None:
        # Imported lazily so missing deps (pure-python-adb, adb binary) only
        # fail when this source is actually selected.
        from oculus_reader.reader import OculusReader  # type: ignore

        try:
            self._reader = OculusReader(ip_address=ip_address, run=True)
        except SystemExit as e:
            # OculusReader calls exit(1) on ADB / device failures. Translate to
            # an exception so the WS route can surface a clean error instead of
            # bringing the backend down.
            raise RuntimeError(f"oculus_reader init failed (code {e.code})") from e
        log.info("OculusReader started (ip=%s)", ip_address or "usb")

    def hello(self) -> dict:
        return {"devices": list(DEVICES), "gt_T_a_b": None, "bases": 0}

    def poll(self, t: float) -> dict[str, list[list[float]]]:
        transforms, _buttons = self._reader.get_transformations_and_buttons()
        out: dict[str, list[list[float]]] = {}
        if not transforms:
            return out
        for ch, dev in _CHAR_TO_DEV.items():
            T = transforms.get(ch)
            if T is None:
                continue
            # OculusReader returns np.ndarray(4,4). JSON-safe nested list.
            out[dev] = np.asarray(T, dtype=float).tolist()
        return out

    def close(self) -> None:
        try:
            self._reader.stop()
        except Exception:
            log.exception("OculusReader stop failed")
