"""Tests for the sync helper in app.calib.sync."""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.calib.sync import sync_streams


def _make_stream(t_start: float, n: int, dt: float = 1.0 / 30.0, motion: str = "circle"):
    """Build a synthetic stream of {ts, T} for the time range [t_start, t_start + n*dt).
    Default motion: a circle in xy with constant 1 rad/s yaw (lots of rotation diversity)."""
    samples = []
    for i in range(n):
        t = t_start + i * dt
        ang = i * dt * 1.0  # rad
        c, s = math.cos(ang), math.sin(ang)
        T = np.eye(4)
        if motion == "circle":
            T[:3, :3] = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)
            T[:3, 3] = [c, s, 0.5 * math.sin(2 * ang)]
        elif motion == "static":
            pass
        samples.append({"ts": t, "T": T.tolist()})
    return samples


def test_sync_recovers_known_offset():
    """Two streams of the same trajectory; UMI's clock is 0.3 s ahead of Vive's.
    Sync should recover delta_t ≈ -0.3 (subtract from umi.ts to align with vive.ts)."""
    vive = _make_stream(t_start=1000.0, n=300, dt=1 / 30)
    umi = _make_stream(t_start=1000.3, n=300, dt=1 / 30)
    res = sync_streams(vive, umi, max_skew_s=2.0, max_pair_gap_s=0.05)
    assert res["ok"] is True
    assert abs(res["delta_t"] + 0.3) < 0.04, f"delta_t={res['delta_t']}"
    assert res["n_pairs"] >= 200


def test_sync_zero_offset():
    """Same start time → delta_t≈0."""
    vive = _make_stream(t_start=2000.0, n=300, dt=1 / 30)
    umi = _make_stream(t_start=2000.0, n=300, dt=1 / 30)
    res = sync_streams(vive, umi, max_skew_s=2.0, max_pair_gap_s=0.05)
    assert res["ok"] is True
    assert abs(res["delta_t"]) < 0.02


def test_sync_static_stream_fails_diversity():
    """Static streams have no motion to lock onto + zero rotation diversity."""
    vive = _make_stream(t_start=3000.0, n=200, dt=1 / 30, motion="static")
    umi = _make_stream(t_start=3000.0, n=200, dt=1 / 30, motion="static")
    res = sync_streams(vive, umi, max_skew_s=2.0, max_pair_gap_s=0.05)
    # Either the SNR check fails (no peak in cross-correlation) or rotation
    # diversity is reported as 0. Both are acceptable outcomes — the caller
    # gates on these fields, not on ok=False.
    assert res["vive_rot_deg"] < 1.0
    assert res["umi_rot_deg"] < 1.0
