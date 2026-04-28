"""Tests for cv2.calibrateHandEye-based solver in app.calib.handeye_pose."""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.calib.handeye_pose import solve_handeye_pose


def _rotmat(axis, ang):
    a = np.asarray(axis, float); a /= np.linalg.norm(a)
    c, s, v = math.cos(ang), math.sin(ang), 1 - math.cos(ang)
    x, y, z = a
    return np.array([
        [c + x * x * v, x * y * v - z * s, x * z * v + y * s],
        [y * x * v + z * s, c + y * y * v, y * z * v - x * s],
        [z * x * v - y * s, z * y * v + x * s, c + z * z * v],
    ])


def _T(R, t):
    out = np.eye(4); out[:3, :3] = R; out[:3, 3] = t; return out


def _build_synced_from_truth(X_true: np.ndarray, n: int = 60, seed: int = 7) -> list[dict]:
    """Generate `n` synced pose pairs (T_vive, T_umi) under T_umi = W · T_vive · X_true,
    with W and a randomly-tumbling rig pose. The world-frame mismatch W is also random
    but constant across samples — the solver should still recover X_true."""
    rng = np.random.default_rng(seed)
    W = _T(_rotmat([0.3, -0.5, 0.8], 0.7), [0.4, -0.2, 0.1])
    pairs = []
    for i in range(n):
        ax = rng.normal(size=3)
        ang = rng.uniform(-2.5, 2.5)
        t = rng.uniform(-1.0, 1.0, size=3)
        T_vive = _T(_rotmat(ax, ang), t)
        T_umi = W @ T_vive @ X_true
        pairs.append({"ts": float(i), "T_vive": T_vive.tolist(), "T_umi": T_umi.tolist()})
    return pairs


def test_solve_handeye_pose_recovers_truth():
    X_true = _T(_rotmat([1.0, 0.5, -0.3], 0.4), [0.07, -0.03, 0.12])
    pairs = _build_synced_from_truth(X_true, n=60)
    res = solve_handeye_pose(pairs, method="daniilidis")
    assert res.ok is True
    X = np.array(res.T)
    R_err = X[:3, :3].T @ X_true[:3, :3]
    cos_ang = (np.trace(R_err) - 1) / 2
    cos_ang = float(np.clip(cos_ang, -1, 1))
    ang_deg = math.degrees(math.acos(cos_ang))
    t_err_mm = 1000.0 * np.linalg.norm(X[:3, 3] - X_true[:3, 3])
    assert ang_deg < 0.5, f"rotation error {ang_deg:.3f}° too large"
    assert t_err_mm < 1.0, f"translation error {t_err_mm:.3f} mm too large"


def test_solve_handeye_pose_too_few_pairs():
    pairs = _build_synced_from_truth(np.eye(4), n=2)
    res = solve_handeye_pose(pairs, method="daniilidis")
    assert res.ok is False
