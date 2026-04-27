"""Mock pose source: two devices on a Lissajous path with a fixed rigid offset."""
from __future__ import annotations

import math

import numpy as np

from app.sources.poses import PoseSource


DEVICES = ["tracker_0", "controller_R"]


def _rodrigues(axis: list[float], ang: float) -> np.ndarray:
    a = np.asarray(axis, dtype=np.float64)
    a = a / (np.linalg.norm(a) or 1.0)
    c, s, v = math.cos(ang), math.sin(ang), 1.0 - math.cos(ang)
    x, y, z = a
    return np.array([
        [c + x*x*v,   x*y*v - z*s, x*z*v + y*s],
        [y*x*v + z*s, c + y*y*v,   y*z*v - x*s],
        [z*x*v - y*s, z*y*v + x*s, c + z*z*v],
    ], dtype=np.float64)


def _ground_truth_link() -> np.ndarray:
    X = np.eye(4)
    X[:3, :3] = _rodrigues([0.3, 0.2, 0.9], 0.18)
    X[:3, 3] = [0.052, -0.018, 0.094]
    return X


def _tracker_pose(t: float) -> np.ndarray:
    R = (
        _rodrigues([1, 0, 0], 0.9 * math.sin(t * 0.7))
        @ _rodrigues([0, 1, 0], 0.6 * math.cos(t * 0.9))
        @ _rodrigues([0, 0, 1], 0.8 * math.sin(t * 0.5 + 0.3))
    )
    p = np.array([
        0.35 * math.sin(t * 0.6),
        0.08 + 0.12 * math.cos(t * 0.4),
        0.25 + 0.15 * math.sin(t * 0.9),
    ])
    T = np.eye(4); T[:3, :3] = R; T[:3, 3] = p
    return T


class MockPoseSource(PoseSource):
    def __init__(self) -> None:
        self._gt = _ground_truth_link()

    def hello(self) -> dict:
        return {"devices": list(DEVICES), "gt_T_a_b": self._gt.tolist(), "bases": 0}

    def poll(self, t: float) -> dict[str, list[list[float]]]:
        Ta = _tracker_pose(t)
        Tb = Ta @ self._gt
        return {DEVICES[0]: Ta.tolist(), DEVICES[1]: Tb.tolist()}
