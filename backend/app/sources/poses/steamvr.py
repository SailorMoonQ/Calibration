"""SteamVR pose source via triad-openvr — Vive trackers, controllers, and HMD.

Device names follow triad-openvr's auto-assigned ids (`tracker_1`, `controller_1`,
`hmd_1`, …). Base stations are filtered out — they don't move during calibration.
`get_pose_matrix()` returns None when a device is momentarily lost; that device is
skipped for the tick rather than dropping the whole sample.
"""
from __future__ import annotations

import logging

from app.sources.poses import PoseSource

log = logging.getLogger("calib.source.steamvr")


def _mat34_to_4x4(m) -> list[list[float]]:
    # triad-openvr returns OpenVR's HmdMatrix34_t (3×4, row-major). Both the
    # ctypes struct and the nested-list fallback are indexable as m[row][col].
    rows = [[float(m[r][c]) for c in range(4)] for r in range(3)]
    rows.append([0.0, 0.0, 0.0, 1.0])
    return rows


class SteamVRPoseSource(PoseSource):
    def __init__(self) -> None:
        try:
            import triad_openvr  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "triad-openvr not installed — run `pip install -e .[steamvr]` "
                "and make sure SteamVR is running"
            ) from e

        try:
            self._ov = triad_openvr.triad_openvr()
        except Exception as e:
            raise RuntimeError(f"SteamVR init failed: {e}") from e

        # Snapshot the tracked set at connect time. Tracking-reference entries
        # are base stations — stationary by design, so not useful for the Link
        # tab — but the count is surfaced via hello() so the Topbar's SteamVR
        # pill can show "N bases".
        all_names = list(self._ov.devices)
        self._bases = sum(1 for n in all_names if n.startswith("tracking_reference"))
        self._devices = sorted(
            name for name in all_names
            if not name.startswith("tracking_reference")
        )
        if not self._devices:
            raise RuntimeError("SteamVR initialized but no tracked devices visible")
        log.info(
            "SteamVR: %d device(s) — %s · %d base(s)",
            len(self._devices), self._devices, self._bases,
        )

    def hello(self) -> dict:
        return {"devices": list(self._devices), "gt_T_a_b": None, "bases": self._bases}

    def poll(self, t: float) -> dict[str, list[list[float]]]:
        out: dict[str, list[list[float]]] = {}
        for name in self._devices:
            dev = self._ov.devices.get(name)
            if dev is None:
                continue
            try:
                m = dev.get_pose_matrix()
            except Exception:
                continue
            if m is None:
                continue
            out[name] = _mat34_to_4x4(m)
        return out

    def close(self) -> None:
        try:
            import openvr  # type: ignore
            openvr.shutdown()
        except Exception:
            log.exception("SteamVR shutdown failed")
