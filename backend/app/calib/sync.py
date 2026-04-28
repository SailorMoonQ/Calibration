"""Sync two pose streams by cross-correlating their speed signals."""
from __future__ import annotations

import logging
import math

import numpy as np

log = logging.getLogger("calib.sync")

_RESAMPLE_HZ = 50.0


def _samples_to_arrays(samples: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ts = np.asarray([s["ts"] for s in samples], dtype=np.float64)
    Ts = np.asarray([s["T"] for s in samples], dtype=np.float64)
    pos = Ts[:, :3, 3]
    R = Ts[:, :3, :3]
    return ts, pos, R


def _resample_positions(ts: np.ndarray, pos: np.ndarray, t_grid: np.ndarray) -> np.ndarray:
    out = np.empty((t_grid.size, 3), dtype=np.float64)
    for axis in range(3):
        out[:, axis] = np.interp(t_grid, ts, pos[:, axis])
    return out


def _speed_signal(ts: np.ndarray, pos: np.ndarray, t_grid: np.ndarray) -> np.ndarray:
    p = _resample_positions(ts, pos, t_grid)
    v = np.linalg.norm(np.diff(p, axis=0), axis=1) * _RESAMPLE_HZ
    return v


def _rotation_diversity_deg(R: np.ndarray) -> float:
    if R.shape[0] < 2:
        return 0.0
    R0_inv = R[0].T
    max_ang = 0.0
    for i in range(1, R.shape[0]):
        delta = R0_inv @ R[i]
        cos_ang = (np.trace(delta) - 1.0) / 2.0
        cos_ang = float(np.clip(cos_ang, -1.0, 1.0))
        ang = math.degrees(math.acos(cos_ang))
        if ang > max_ang:
            max_ang = ang
    return max_ang


def _xcorr_peak(a: np.ndarray, b: np.ndarray, max_lag: int) -> tuple[int, float]:
    a = a - a.mean()
    b = b - b.mean()
    n = min(a.size, b.size)
    a = a[:n]
    b = b[:n]
    lags = np.arange(-max_lag, max_lag + 1)
    cc = np.empty(lags.size, dtype=np.float64)
    for k, lag in enumerate(lags):
        if lag >= 0:
            cc[k] = float(np.dot(a[lag:], b[: n - lag]))
        else:
            cc[k] = float(np.dot(a[: n + lag], b[-lag:]))
    cc_abs = np.abs(cc)
    peak_idx = int(np.argmax(cc_abs))
    peak = cc_abs[peak_idx]
    mean = float(cc_abs.mean()) or 1e-9
    return int(lags[peak_idx]), peak / mean


def sync_streams(
    vive: list[dict],
    umi: list[dict],
    max_skew_s: float = 5.0,
    max_pair_gap_s: float = 0.05,
) -> dict:
    if len(vive) < 10 or len(umi) < 10:
        return {
            "ok": False,
            "reason": f"streams too short (vive={len(vive)} umi={len(umi)})",
            "delta_t": 0.0, "n_pairs": 0,
            "vive_rot_deg": 0.0, "umi_rot_deg": 0.0,
            "pairs": [],
        }

    ts_v, pos_v, R_v = _samples_to_arrays(vive)
    ts_u, pos_u, R_u = _samples_to_arrays(umi)

    t_lo = max(ts_v[0], ts_u[0]) - max_skew_s
    t_hi = min(ts_v[-1], ts_u[-1]) + max_skew_s
    if t_hi - t_lo < 1.0:
        return {
            "ok": False,
            "reason": f"streams don't overlap within {max_skew_s}s",
            "delta_t": 0.0, "n_pairs": 0,
            "vive_rot_deg": 0.0, "umi_rot_deg": 0.0,
            "pairs": [],
        }
    t_grid = np.arange(t_lo, t_hi, 1.0 / _RESAMPLE_HZ)

    sv = _speed_signal(ts_v, pos_v, t_grid)
    su = _speed_signal(ts_u, pos_u, t_grid)

    max_lag = int(max_skew_s * _RESAMPLE_HZ)
    lag, snr = _xcorr_peak(sv, su, max_lag)
    delta_t = lag / _RESAMPLE_HZ

    if snr < 2.0:
        return {
            "ok": False,
            "reason": f"low cross-correlation SNR ({snr:.2f} < 2.0); user probably didn't move enough",
            "delta_t": float(delta_t), "n_pairs": 0,
            "vive_rot_deg": float(_rotation_diversity_deg(R_v)),
            "umi_rot_deg": float(_rotation_diversity_deg(R_u)),
            "pairs": [],
        }

    ts_u_aligned = ts_u + delta_t
    j = 0
    pairs = []
    for i, tv in enumerate(ts_v):
        while j + 1 < len(ts_u_aligned) and abs(ts_u_aligned[j + 1] - tv) < abs(ts_u_aligned[j] - tv):
            j += 1
        gap = abs(ts_u_aligned[j] - tv)
        if gap <= max_pair_gap_s:
            pairs.append({
                "ts": float(tv),
                "T_vive": vive[i]["T"],
                "T_umi": umi[j]["T"],
            })

    return {
        "ok": True,
        "delta_t": float(delta_t),
        "snr": float(snr),
        "n_pairs": len(pairs),
        "vive_rot_deg": float(_rotation_diversity_deg(R_v)),
        "umi_rot_deg": float(_rotation_diversity_deg(R_u)),
        "pairs": pairs,
    }
