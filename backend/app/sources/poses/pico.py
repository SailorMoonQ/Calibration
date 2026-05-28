"""PICO pose source via XRoboToolkit's PC-Service pybind module.

The module (`xrobotoolkit_sdk`) is built from source — see INSTALL.md — and
talks to a user-launched XRoboToolkit PC Service daemon, which in turn receives
poses over the network from the XRoboToolkit client APK on the headset. We
expose the two controllers and the headset.

`xrobotoolkit_sdk` returns each pose as [x, y, z, qx, qy, qz, qw] (meters +
unit quaternion); we convert to the 4x4 nested-list contract every PoseSource
returns from poll().
"""
from __future__ import annotations

import logging
import math

from app.sources.poses import PoseSource

log = logging.getLogger("calib.source.pico")

DEVICES = ["pico_ctrl_l", "pico_ctrl_r", "pico_hmd"]


def _pose7_to_4x4(p) -> list[list[float]] | None:
    """Convert [x,y,z,qx,qy,qz,qw] to a 4x4 row-major nested list.

    Returns None for a missing/short pose or a zero-norm quaternion (the
    signal XRoboToolkit gives for a momentarily-untracked device).
    """
    if p is None or len(p) != 7:
        return None
    x, y, z, qx, qy, qz, qw = (float(v) for v in p)
    n = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if n < 1e-9:
        return None
    qx, qy, qz, qw = qx / n, qy / n, qz / n, qw / n
    return [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw),     2 * (qx * qz + qy * qw),     x],
        [2 * (qx * qy + qz * qw),     1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),     y],
        [2 * (qx * qz - qy * qw),     2 * (qy * qz + qx * qw),     1 - 2 * (qx * qx + qy * qy), z],
        [0.0, 0.0, 0.0, 1.0],
    ]


class PicoPoseSource(PoseSource):
    def __init__(self) -> None:
        try:
            import xrobotoolkit_sdk as xrt  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "PICO support not installed — build xrobotoolkit_sdk and see "
                "INSTALL.md (PICO section)"
            ) from e
        try:
            xrt.init()
        except Exception as e:
            raise RuntimeError(
                f"PICO init failed: {e} — is the XRoboToolkit PC Service running "
                "and the headset connected?"
            ) from e
        self._xrt = xrt
        log.info("PicoPoseSource initialized via xrobotoolkit_sdk")

    def hello(self) -> dict:
        return {"devices": list(DEVICES), "gt_T_a_b": None, "bases": 0}

    def poll(self, t: float) -> dict[str, list[list[float]]]:
        readers = (
            ("pico_ctrl_l", self._xrt.get_left_controller_pose),
            ("pico_ctrl_r", self._xrt.get_right_controller_pose),
            ("pico_hmd", self._xrt.get_headset_pose),
        )
        out: dict[str, list[list[float]]] = {}
        for dev, read in readers:
            try:
                m = _pose7_to_4x4(read())
            except Exception:
                continue
            if m is not None:
                out[dev] = m
        return out

    def close(self) -> None:
        try:
            self._xrt.close()
        except Exception:
            log.exception("xrobotoolkit_sdk close failed")
