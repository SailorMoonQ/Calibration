#!/usr/bin/env python3
"""Vive <-> Genrobot UMI hand-eye precision report generator.

Reads two capture sessions written by the GUI (LinkCalibTab):

  motion-dir/  vive.json  umi.json  [synced.json]   (rich rotation, ≥60 s)
  static-dir/  vive.json  umi.json                  (rig held still, ≥60 s)

Solves T_vive_umi with all five cv2 hand-eye methods, computes per-pair
residuals, characterises static-mount drift/jitter, renders plots, and
writes a Markdown report. Self-consistency only — no external ground truth.

Run with the backend venv (it already has cv2 + numpy; matplotlib is added
on demand for this tool). The script imports app.calib.handeye_pose and
app.calib.sync directly — no backend HTTP server required.

  backend/.venv/bin/python scripts/precision_report.py \\
      --motion-dir <path> --static-dir <path>

Output (default --out-dir docs/precision/):
  report.md          Markdown narrative with embedded figures
  figs/*.png         residual + stability plots
  data/metrics.json  machine-readable copy of every number in the report
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

from app.calib.handeye_pose import _per_pair_residuals, solve_handeye_pose  # noqa: E402
from app.calib.sync import pair_at_offset, sync_streams  # noqa: E402

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except ImportError:
    sys.stderr.write(
        "matplotlib is required for the precision report.\n"
        "Install it into the backend venv:\n"
        "  backend/.venv/bin/pip install matplotlib\n"
    )
    sys.exit(2)

METHODS = ("daniilidis", "tsai", "park", "horaud", "andreff")


# --- data loading ---------------------------------------------------------

def _load_samples(path: Path) -> list[dict]:
    with open(path) as f:
        doc = json.load(f)
    samples = doc.get("samples") or []
    if not samples:
        raise SystemExit(f"{path}: no samples")
    return samples


def _samples_T(samples: list[dict]) -> np.ndarray:
    return np.asarray([s["T"] for s in samples], dtype=np.float64)


def _samples_ts(samples: list[dict]) -> np.ndarray:
    return np.asarray([s["ts"] for s in samples], dtype=np.float64)


# --- math helpers ---------------------------------------------------------

def _rotmat_to_rotvec_deg(R: np.ndarray) -> float:
    cos = (np.trace(R) - 1.0) / 2.0
    cos = float(np.clip(cos, -1.0, 1.0))
    return math.degrees(math.acos(cos))


def _stats(values: np.ndarray) -> dict:
    if values.size == 0:
        return {"n": 0, "mean": 0.0, "rms": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0, "std": 0.0}
    return {
        "n": int(values.size),
        "mean": float(values.mean()),
        "rms": float(np.sqrt(np.mean(values ** 2))),
        "p50": float(np.percentile(values, 50)),
        "p95": float(np.percentile(values, 95)),
        "max": float(values.max()),
        "std": float(values.std(ddof=0)),
    }


# --- hand-eye residuals ---------------------------------------------------

@dataclass
class MethodResult:
    method: str
    ok: bool
    message: str
    T: list | None
    rot_deg_per_pair: list[float]
    pos_mm_per_pair: list[float]
    rot_stats: dict
    pos_stats: dict


def _solve_all_methods(
    pairs: list[dict], pattern: str, methods: tuple[str, ...]
) -> list[MethodResult]:
    out: list[MethodResult] = []
    T_vive_list = [np.asarray(p["T_vive"], np.float64) for p in pairs]
    T_umi_list = [np.asarray(p["T_umi"], np.float64) for p in pairs]
    if pattern == "eye_to_hand":
        T_vive_eff = [np.linalg.inv(T) for T in T_vive_list]
    else:
        T_vive_eff = T_vive_list
    for m in methods:
        res = solve_handeye_pose(pairs, method=m, pattern=pattern)
        if not res.ok or res.T is None:
            out.append(MethodResult(
                method=m, ok=False, message=res.message or "", T=None,
                rot_deg_per_pair=[], pos_mm_per_pair=[],
                rot_stats=_stats(np.array([])), pos_stats=_stats(np.array([])),
            ))
            continue
        X = np.asarray(res.T, dtype=np.float64)
        rot, pos = _per_pair_residuals(T_vive_eff, T_umi_list, X, pattern)
        out.append(MethodResult(
            method=m, ok=True, message=res.message or "", T=X.tolist(),
            rot_deg_per_pair=rot, pos_mm_per_pair=pos,
            rot_stats=_stats(np.asarray(rot)), pos_stats=_stats(np.asarray(pos)),
        ))
    return out


def _pick_best(method_results: list[MethodResult]) -> MethodResult | None:
    okrs = [r for r in method_results if r.ok]
    if not okrs:
        return None
    return min(okrs, key=lambda r: r.pos_stats["rms"])


# --- drift decomposition: bias / drift-rate / noise (Vive-as-truth lens) ---

def _line_fit(t: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    """Least-squares y = b + s*t. Returns (intercept_b, slope_s, detrended_std)."""
    if t.size < 2:
        return float(y.mean() if y.size else 0.0), 0.0, 0.0
    A = np.vstack([t, np.ones_like(t)]).T
    s, b = np.linalg.lstsq(A, y, rcond=None)[0]
    resid = y - (b + s * t)
    return float(b), float(s), float(resid.std(ddof=0))


def _drift_decomposition(pairs: list[dict], X: np.ndarray, pattern: str) -> dict:
    """Vive-as-truth view: split per-pair UMI residual into bias + drift + noise.

    Same residual `Wᵢ = T_umi · X⁻¹ · T_vive⁻¹` (eye-in-hand) the solver uses;
    we decompose its magnitude time-series into a constant component (bias),
    a linear component (drift over the capture window), and the detrended
    standard deviation (per-frame noise), then repeat for each spatial axis.
    """
    T_v_orig = [np.asarray(p["T_vive"], np.float64) for p in pairs]
    T_u = [np.asarray(p["T_umi"], np.float64) for p in pairs]
    if pattern == "eye_to_hand":
        T_v = [np.linalg.inv(T) for T in T_v_orig]
    else:
        T_v = T_v_orig

    Xinv = np.linalg.inv(X)
    if pattern == "eye_in_hand":
        Ws = np.array([Tu @ Xinv @ np.linalg.inv(Tv)
                       for Tv, Tu in zip(T_v, T_u, strict=False)])
    else:
        Ws = np.array([Tv @ X @ np.linalg.inv(Tu)
                       for Tv, Tu in zip(T_v, T_u, strict=False)])
    R_mean = Ws[:, :3, :3].mean(axis=0)
    U, _, Vt = np.linalg.svd(R_mean)
    R_ref = U @ np.diag([1, 1, np.linalg.det(U @ Vt)]) @ Vt
    t_ref = Ws[:, :3, 3].mean(axis=0)

    ts = np.asarray([p["ts"] for p in pairs])
    t = ts - ts[0]

    # Magnitude time-series
    pos_mag_mm = np.linalg.norm((Ws[:, :3, 3] - t_ref) * 1000.0, axis=1)
    rot_mag_deg = np.array([_rotmat_to_rotvec_deg(W[:3, :3].T @ R_ref) for W in Ws])

    bp_mm, sp_mm_per_s, np_mm = _line_fit(t, pos_mag_mm)
    br_deg, sr_deg_per_s, nr_deg = _line_fit(t, rot_mag_deg)

    # Per-axis signed residual (mm) — useful for spotting directional drift
    dpos_mm = (Ws[:, :3, 3] - t_ref) * 1000.0
    axis_fits = {}
    for k, axis in enumerate("xyz"):
        b, s, nse = _line_fit(t, dpos_mm[:, k])
        axis_fits[axis] = {
            "bias_mm": b,
            "slope_mm_s": s,
            "noise_mm": nse,
            "max_mm": float(np.abs(dpos_mm[:, k]).max()),
        }

    return {
        "duration_s": float(t[-1]),
        "n_pairs": int(len(pairs)),
        "position": {
            "bias_mm": bp_mm,
            "drift_mm_s": sp_mm_per_s,
            "noise_mm": np_mm,
            "max_mm": float(pos_mag_mm.max()),
            "rms_mm": float(np.sqrt((pos_mag_mm ** 2).mean())),
        },
        "rotation": {
            "bias_deg": br_deg,
            "drift_deg_s": sr_deg_per_s,
            "noise_deg": nr_deg,
            "max_deg": float(rot_mag_deg.max()),
            "rms_deg": float(np.sqrt((rot_mag_deg ** 2).mean())),
        },
        "per_axis": axis_fits,
        "_t": t.tolist(),
        "_pos_mag_mm": pos_mag_mm.tolist(),
        "_rot_mag_deg": rot_mag_deg.tolist(),
        "_pos_axis_mm": dpos_mm.tolist(),
    }


# --- static stability ----------------------------------------------------

def _static_stream_stats(samples: list[dict]) -> dict:
    Ts = _samples_T(samples)
    ts = _samples_ts(samples)
    pos_m = Ts[:, :3, 3]
    pos_mm = pos_m * 1000.0
    pos_centered = pos_mm - pos_mm.mean(axis=0)
    sigma_axis_mm = pos_mm.std(axis=0, ddof=0)
    norm_dev = np.linalg.norm(pos_centered, axis=1)

    Rs = Ts[:, :3, :3]
    R_med = Rs.mean(axis=0)
    U, _, Vt = np.linalg.svd(R_med)
    R_ref = U @ np.diag([1, 1, np.linalg.det(U @ Vt)]) @ Vt
    angs = []
    for R in Rs:
        angs.append(_rotmat_to_rotvec_deg(R.T @ R_ref))
    angs = np.asarray(angs)

    return {
        "n": int(len(samples)),
        "duration_s": float(ts[-1] - ts[0]) if len(ts) > 1 else 0.0,
        "rate_hz": float((len(ts) - 1) / (ts[-1] - ts[0])) if (len(ts) > 1 and ts[-1] > ts[0]) else 0.0,
        "pos_sigma_mm": {
            "x": float(sigma_axis_mm[0]),
            "y": float(sigma_axis_mm[1]),
            "z": float(sigma_axis_mm[2]),
            "norm": float(norm_dev.std(ddof=0)),
            "p95": float(np.percentile(norm_dev, 95)),
            "max": float(norm_dev.max()),
        },
        "rot_sigma_deg": {
            "std": float(angs.std(ddof=0)),
            "p95": float(np.percentile(angs, 95)),
            "max": float(angs.max()),
        },
        "ts": ts.tolist(),
        "pos_mm": pos_mm.tolist(),
        "rot_dev_deg": angs.tolist(),
    }


def _static_cross_stats(
    vive_samples: list[dict], umi_samples: list[dict], X: np.ndarray, max_pair_gap_s: float = 0.05,
) -> dict:
    pairs = pair_at_offset(vive_samples, umi_samples, delta_t=0.0, max_pair_gap_s=max_pair_gap_s)
    if not pairs:
        return {"n_pairs": 0, "note": "no pairs within max_pair_gap_s"}
    T_v = np.asarray([p["T_vive"] for p in pairs], np.float64)
    T_u = np.asarray([p["T_umi"] for p in pairs], np.float64)
    pos_mm = []
    rot_deg = []
    for i in range(len(pairs)):
        T_pred = T_v[i] @ X
        dT = np.linalg.inv(T_pred) @ T_u[i]
        pos_mm.append(1000.0 * float(np.linalg.norm(dT[:3, 3])))
        rot_deg.append(_rotmat_to_rotvec_deg(dT[:3, :3]))
    return {
        "n_pairs": len(pairs),
        "pos_stats_mm": _stats(np.asarray(pos_mm)),
        "rot_stats_deg": _stats(np.asarray(rot_deg)),
        "ts": [p["ts"] for p in pairs],
        "pos_mm": pos_mm,
        "rot_deg": rot_deg,
    }


# --- plotting -------------------------------------------------------------

def _plot_method_residual_hist(method_results: list[MethodResult], path: Path, kind: str) -> None:
    okrs = [r for r in method_results if r.ok]
    if not okrs:
        return
    fig, ax = plt.subplots(figsize=(8, 4.5))
    bins = 30
    for r in okrs:
        vals = r.pos_mm_per_pair if kind == "pos" else r.rot_deg_per_pair
        ax.hist(vals, bins=bins, alpha=0.45, label=r.method, density=True)
    ax.set_xlabel("position residual (mm)" if kind == "pos" else "rotation residual (deg)")
    ax.set_ylabel("density")
    ax.set_title(f"Per-pair {'position' if kind == 'pos' else 'rotation'} residuals — all methods")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_residual_timeseries(best: MethodResult, path: Path) -> None:
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(8, 5), sharex=True)
    idx = np.arange(len(best.pos_mm_per_pair))
    a1.plot(idx, best.pos_mm_per_pair, lw=0.8)
    a1.axhline(best.pos_stats["rms"], color="r", ls="--", lw=0.8,
               label=f"RMS {best.pos_stats['rms']:.2f} mm")
    a1.set_ylabel("position (mm)")
    a1.set_title(f"Per-pair residual — method = {best.method}")
    a1.legend()
    a1.grid(True, alpha=0.3)
    a2.plot(idx, best.rot_deg_per_pair, lw=0.8, color="C2")
    a2.axhline(best.rot_stats["rms"], color="r", ls="--", lw=0.8,
               label=f"RMS {best.rot_stats['rms']:.3f} deg")
    a2.set_xlabel("pair index")
    a2.set_ylabel("rotation (deg)")
    a2.legend()
    a2.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_method_compare(method_results: list[MethodResult], path: Path) -> None:
    okrs = [r for r in method_results if r.ok]
    if not okrs:
        return
    names = [r.method for r in okrs]
    pos_rms = [r.pos_stats["rms"] for r in okrs]
    rot_rms = [r.rot_stats["rms"] for r in okrs]
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 4))
    a1.bar(names, pos_rms, color="C0")
    a1.set_ylabel("position RMS (mm)")
    a1.set_title("Position RMS per method")
    a1.grid(True, alpha=0.3, axis="y")
    a2.bar(names, rot_rms, color="C2")
    a2.set_ylabel("rotation RMS (deg)")
    a2.set_title("Rotation RMS per method")
    a2.grid(True, alpha=0.3, axis="y")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_static_pos(stats: dict, label: str, path: Path) -> None:
    ts = np.asarray(stats["ts"])
    t0 = ts[0] if ts.size else 0.0
    pos = np.asarray(stats["pos_mm"])
    pos_c = pos - pos.mean(axis=0)
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(8, 5), sharex=True)
    for k, axis in enumerate("xyz"):
        a1.plot(ts - t0, pos_c[:, k], lw=0.7, label=axis)
    a1.set_ylabel("position (mm, centered)")
    a1.set_title(
        f"Static position — {label}  "
        f"(σx {stats['pos_sigma_mm']['x']:.3f}  "
        f"σy {stats['pos_sigma_mm']['y']:.3f}  "
        f"σz {stats['pos_sigma_mm']['z']:.3f} mm)"
    )
    a1.legend(loc="upper right")
    a1.grid(True, alpha=0.3)
    rot = np.asarray(stats["rot_dev_deg"])
    a2.plot(ts - t0, rot, lw=0.7, color="C3")
    a2.set_xlabel("time (s)")
    a2.set_ylabel("rot deviation (deg)")
    a2.set_title(
        f"Rotation deviation — σ {stats['rot_sigma_deg']['std']:.4f}°  "
        f"p95 {stats['rot_sigma_deg']['p95']:.4f}°"
    )
    a2.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_static_xy(stats: dict, label: str, path: Path) -> None:
    pos = np.asarray(stats["pos_mm"])
    pos_c = pos - pos.mean(axis=0)
    fig, ax = plt.subplots(figsize=(5.5, 5.5))
    ax.scatter(pos_c[:, 0], pos_c[:, 1], s=4, alpha=0.4)
    ax.axhline(0, color="k", lw=0.4, alpha=0.4)
    ax.axvline(0, color="k", lw=0.4, alpha=0.4)
    ax.set_aspect("equal", adjustable="datalim")
    ax.set_xlabel("x (mm, centered)")
    ax.set_ylabel("y (mm, centered)")
    ax.set_title(f"Static XY scatter — {label}")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_drift(drift: dict, path: Path) -> None:
    t = np.asarray(drift["_t"])
    pos = np.asarray(drift["_pos_mag_mm"])
    rot = np.asarray(drift["_rot_mag_deg"])
    bp, sp = drift["position"]["bias_mm"], drift["position"]["drift_mm_s"]
    br, sr = drift["rotation"]["bias_deg"], drift["rotation"]["drift_deg_s"]

    fig, (a1, a2) = plt.subplots(2, 1, figsize=(8.5, 5.2), sharex=True)
    a1.plot(t, pos, lw=0.7, color="C0", label="|residual|")
    a1.plot(t, bp + sp * t, lw=1.4, color="C3",
            label=f"fit: {bp:.2f} mm + {sp * 1000:.2f} mm/s · t  (×10⁻³)")
    a1.set_ylabel("position residual (mm)")
    a1.set_title("UMI residual vs time — Vive treated as ground truth")
    a1.legend(loc="upper left", fontsize=9)
    a1.grid(True, alpha=0.3)

    a2.plot(t, rot, lw=0.7, color="C2", label="|residual|")
    a2.plot(t, br + sr * t, lw=1.4, color="C3",
            label=f"fit: {br:.3f}° + {sr * 1000:.3f}°/s · t  (×10⁻³)")
    a2.set_xlabel("time (s)")
    a2.set_ylabel("rotation residual (deg)")
    a2.legend(loc="upper left", fontsize=9)
    a2.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_drift_axes(drift: dict, path: Path) -> None:
    t = np.asarray(drift["_t"])
    dpos = np.asarray(drift["_pos_axis_mm"])
    fig, ax = plt.subplots(figsize=(8.5, 4))
    for k, axis in enumerate("xyz"):
        s = drift["per_axis"][axis]["slope_mm_s"]
        b = drift["per_axis"][axis]["bias_mm"]
        ax.plot(t, dpos[:, k], lw=0.6, alpha=0.7, label=f"{axis}: {s * 1000:+.2f} mm/s · t")
        ax.plot(t, b + s * t, lw=1.0, ls="--", color=f"C{k}", alpha=0.9)
    ax.axhline(0, color="k", lw=0.4, alpha=0.4)
    ax.set_xlabel("time (s)")
    ax.set_ylabel("signed residual (mm, world frame)")
    ax.set_title("Per-axis position residual + linear fit")
    ax.legend(loc="upper left", fontsize=9)
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_static_cross(cross: dict, path: Path) -> None:
    if cross.get("n_pairs", 0) == 0:
        return
    ts = np.asarray(cross["ts"])
    t0 = ts[0]
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(8, 5), sharex=True)
    a1.plot(ts - t0, cross["pos_mm"], lw=0.7)
    rms = cross["pos_stats_mm"]["rms"]
    a1.axhline(rms, color="r", ls="--", lw=0.8, label=f"RMS {rms:.2f} mm")
    a1.set_ylabel("position mismatch (mm)")
    a1.set_title("Static T_vive · X  vs  T_umi  —  position mismatch")
    a1.legend()
    a1.grid(True, alpha=0.3)
    a2.plot(ts - t0, cross["rot_deg"], lw=0.7, color="C2")
    rms = cross["rot_stats_deg"]["rms"]
    a2.axhline(rms, color="r", ls="--", lw=0.8, label=f"RMS {rms:.3f} deg")
    a2.set_xlabel("time (s)")
    a2.set_ylabel("rotation mismatch (deg)")
    a2.legend()
    a2.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def _plot_trajectory(pairs: list[dict], X: np.ndarray, path: Path) -> None:
    """Overlay the two pose streams in UMI's world frame.

    Eye-in-hand identity: T_umi = W · T_vive · X, where W is the (constant)
    Vive-world → UMI-world transform. The solver returns X but not W, so we
    estimate W from the data: Wᵢ = T_umi · X⁻¹ · T_vive⁻¹, then take the
    SVD-mean across all pairs as the most-consistent W̄. Applying W̄ brings
    the Vive-prediction trace into UMI's world; if the mount is rigid the
    two traces visually overlap, with residuals ≈ the §4 numbers.
    """
    if not pairs:
        return
    Tv = np.asarray([p["T_vive"] for p in pairs], np.float64)
    Tu = np.asarray([p["T_umi"] for p in pairs], np.float64)

    Xinv = np.linalg.inv(X)
    Ws = np.einsum("nij,jk,nkl->nil", Tu, Xinv, np.linalg.inv(Tv))
    R_mean = Ws[:, :3, :3].mean(axis=0)
    U, _, Vt = np.linalg.svd(R_mean)
    R_W = U @ np.diag([1, 1, np.linalg.det(U @ Vt)]) @ Vt
    t_W = Ws[:, :3, 3].mean(axis=0)
    W = np.eye(4)
    W[:3, :3] = R_W
    W[:3, 3] = t_W

    Tv_pred = np.einsum("ij,njk,kl->nil", W, Tv, X)
    Tv_pred_pos = Tv_pred[:, :3, 3] * 1000.0
    Tu_pos = Tu[:, :3, 3] * 1000.0

    err = np.linalg.norm(Tv_pred_pos - Tu_pos, axis=1)

    fig = plt.figure(figsize=(8, 6.5))
    ax = fig.add_subplot(111, projection="3d")
    ax.plot(Tu_pos[:, 0], Tu_pos[:, 1], Tu_pos[:, 2],
            lw=1.4, label="T_umi  (observed)", color="C0")
    ax.plot(Tv_pred_pos[:, 0], Tv_pred_pos[:, 1], Tv_pred_pos[:, 2],
            lw=1.0, ls="--", label="W · T_vive · X  (predicted)", color="C3", alpha=0.85)
    ax.scatter(Tu_pos[0, 0], Tu_pos[0, 1], Tu_pos[0, 2], s=22, c="k", marker="o", label="start")
    ax.set_xlabel("x (mm, UMI world)")
    ax.set_ylabel("y (mm, UMI world)")
    ax.set_zlabel("z (mm, UMI world)")
    ax.set_title(
        f"Trajectory overlay in UMI world  ·  match RMS = {np.sqrt((err**2).mean()):.2f} mm "
        f"(max {err.max():.2f} mm)"
    )
    ax.legend(loc="upper left", fontsize=9)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


# --- markdown rendering ---------------------------------------------------

def _fmt_T(T: list[list[float]] | np.ndarray) -> str:
    arr = np.asarray(T, dtype=np.float64)
    return "\n".join("  ".join(f"{v: .6f}" for v in r) for r in arr)


def _table(headers: list[str], rows: list[list[str]]) -> str:
    line1 = "| " + " | ".join(headers) + " |"
    line2 = "| " + " | ".join(["---"] * len(headers)) + " |"
    body = "\n".join("| " + " | ".join(r) + " |" for r in rows)
    return f"{line1}\n{line2}\n{body}"


def _stats_row(prefix: str, st: dict, unit: str) -> list[str]:
    return [
        prefix,
        f"{st['n']}",
        f"{st['mean']:.3f}",
        f"{st['rms']:.3f}",
        f"{st['p50']:.3f}",
        f"{st['p95']:.3f}",
        f"{st['max']:.3f}",
        unit,
    ]


def render_short_markdown(
    motion_meta: dict, sync_meta: dict, best: MethodResult, drift: dict,
) -> str:
    """One-page brief: methodology, headline numbers, and the trajectory overlay."""
    figs = "figs"
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    p_pos = drift["position"]
    p_rot = drift["rotation"]

    lines: list[str] = []
    lines.append("# Vive ↔ Genrobot UMI — Precision Test (Short Report)")
    lines.append("")
    lines.append(f"_Generated {today}._  See `report.md` for the full breakdown.")
    lines.append("")

    lines.append("## 1. How the test was run")
    lines.append("")
    lines.append(
        f"The Vive tracker was rigidly mounted on the Genrobot UMI headset and both pose "
        f"streams were recorded simultaneously over a single **{drift['duration_s']:.0f}-second** "
        f"window of free motion ({sync_meta['vive_rot_deg']:.0f}° rotation diversity). "
        f"After timestamp alignment ({sync_meta['n_pairs']} synced pairs), the rigid mount "
        f"`T_vive_umi` was solved with `cv2.calibrateHandEye` (best method: **{best.method}**, "
        f"selected by lowest position residual). With the Vive tracker treated as ground truth "
        f"and the solved extrinsics applied, the per-pair residual quantifies UMI's pose error."
    )
    lines.append("")

    lines.append("## 2. Result summary")
    lines.append("")
    lines.append(_table(
        ["metric", "position", "rotation"],
        [
            ["typical error (RMS)",            f"**{p_pos['rms_mm']:.2f} mm**",  f"**{p_rot['rms_deg']:.3f}°**"],
            ["worst case (max in window)",     f"{p_pos['max_mm']:.2f} mm",      f"{p_rot['max_deg']:.3f}°"],
            ["fixed bias",                     f"{p_pos['bias_mm']:.2f} mm",     f"{p_rot['bias_deg']:.3f}°"],
            ["drift over full window",         f"{p_pos['drift_mm_s'] * drift['duration_s']:+.2f} mm",
                                               f"{p_rot['drift_deg_s'] * drift['duration_s']:+.3f}°"],
            ["per-frame noise (1σ)",           f"{p_pos['noise_mm']:.2f} mm",    f"{p_rot['noise_deg']:.3f}°"],
        ],
    ))
    lines.append("")
    lines.append(
        f"> **Headline:** UMI tracks Vive within **{p_pos['rms_mm']:.1f} mm / {p_rot['rms_deg']:.2f}°** "
        f"(1σ) over the {drift['duration_s']:.0f}-s capture, with worst-case excursions to "
        f"{p_pos['max_mm']:.0f} mm / {p_rot['max_deg']:.1f}°."
    )
    lines.append("")

    lines.append("## 3. Trajectories after extrinsics")
    lines.append("")
    lines.append(
        "Vive trajectory mapped through the solved `T_vive_umi`, overlaid on the directly "
        "observed UMI trajectory in the same frame. Tight overlap = good extrinsics."
    )
    lines.append("")
    lines.append(f"![Trajectories after extrinsics]({figs}/trajectory.png)")
    lines.append("")
    return "\n".join(lines)


def render_markdown(
    motion_meta: dict, sync_meta: dict, method_results: list[MethodResult],
    best: MethodResult, static_v: dict, static_u: dict, static_cross: dict,
    drift: dict,
) -> str:
    figs = "figs"
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines: list[str] = []
    lines.append("# Vive ↔ Genrobot UMI — Precision Calibration Report")
    lines.append("")
    lines.append(
        f"_Generated {today} from `{motion_meta['motion_dir']}` (motion) "
        f"and `{static_v['source_dir']}` (static)._"
    )
    lines.append("")
    lines.append(
        "The Vive tracker is treated as ground truth; all error numbers below describe how "
        "the Genrobot UMI VIO pose disagrees with Vive over a single rigid-mount capture. "
        "Use the executive summary to set tolerances; sections 2–7 back the numbers up."
    )
    lines.append("")

    p_pos = drift["position"]
    p_rot = drift["rotation"]
    lines.append("## 0. Executive summary  —  is UMI good enough?")
    lines.append("")
    lines.append(_table(
        ["metric", "position", "rotation", "what to read into it"],
        [
            ["typical error (RMS)",
             f"**{p_pos['rms_mm']:.2f} mm**", f"**{p_rot['rms_deg']:.3f}°**",
             "the number to quote as 1σ accuracy"],
            ["worst case (max in window)",
             f"{p_pos['max_mm']:.2f} mm", f"{p_rot['max_deg']:.3f}°",
             "rare excursion; tolerance must accept this"],
            ["fixed bias",
             f"{p_pos['bias_mm']:.2f} mm", f"{p_rot['bias_deg']:.3f}°",
             "constant misalignment, recoverable with cleaner X"],
            ["drift over full window",
             f"{p_pos['drift_mm_s'] * drift['duration_s']:+.2f} mm", f"{p_rot['drift_deg_s'] * drift['duration_s']:+.3f}°",
             f"accumulating error over {drift['duration_s']:.0f} s"],
            ["per-frame noise (1σ)",
             f"{p_pos['noise_mm']:.2f} mm", f"{p_rot['noise_deg']:.3f}°",
             "tick-to-tick jitter, not reducible by averaging the rig"],
        ],
    ))
    lines.append("")
    lines.append("**How to read these numbers when budgeting tolerance**")
    lines.append("")
    lines.append(
        f"- For a **single-shot pose query**, plan for **{p_pos['rms_mm']:.1f} mm / "
        f"{p_rot['rms_deg']:.2f}° (1σ)**. Roughly 95 % of frames will fall within "
        f"~{2 * p_pos['rms_mm']:.1f} mm / ~{2 * p_rot['rms_deg']:.2f}° (2σ)."
    )
    lines.append(
        f"- For **continuous teleop** over similar window length ({drift['duration_s']:.0f} s), "
        "the constant bias matters most — re-running the calibration with longer/cleaner data "
        "can reduce it; the drift component is small here but grows linearly with capture time."
    )
    lines.append(
        "- The static section (§5) gives a noise-floor for what's even physically resolvable: "
        f"Vive ≈ {static_v['pos_sigma_mm']['norm']:.2f} mm, "
        f"UMI ≈ {static_u['pos_sigma_mm']['norm']:.2f} mm 1σ when the rig is still. "
        "Targets below those are not recoverable from this hardware."
    )
    lines.append(
        "- **Caveats**: this is a single 30 s window; numbers will widen with longer captures "
        "or wider operating envelopes, and tighten with a cleaner re-calibration."
    )
    lines.append("")
    rms_mm = p_pos["rms_mm"]
    rms_deg = p_rot["rms_deg"]

    def _verdict(measured: float, threshold: float) -> str:
        ratio = measured / threshold if threshold > 0 else float("inf")
        if ratio < 0.5:
            return "✅ comfortable"
        if ratio < 1.0:
            return "✅ fits"
        if ratio < 2.0:
            return "⚠️ marginal"
        return "❌ insufficient"

    lines.append("**Tolerance reference — does this UMI clear common bars?**")
    lines.append("")
    lines.append(_table(
        ["application class", "typical tolerance", "verdict at this UMI accuracy"],
        [
            ["high-precision assembly / surgical",         "≤ 1 mm  · ≤ 0.1°",  f"{_verdict(rms_mm, 1.0)} ({rms_mm:.1f} mm vs 1 mm)"],
            ["pick-and-place, small objects (<5 cm)",      "≤ 5 mm  · ≤ 0.5°",  f"{_verdict(rms_mm, 5.0)} ({rms_mm:.1f} mm vs 5 mm)"],
            ["pick-and-place, large objects (>10 cm)",     "≤ 10 mm · ≤ 1°",    f"{_verdict(rms_mm, 10.0)} ({rms_mm:.1f} mm vs 10 mm)"],
            ["whole-body teleop / loco-manipulation",      "≤ 20 mm · ≤ 2°",    f"{_verdict(rms_mm, 20.0)} ({rms_mm:.1f} mm vs 20 mm)"],
            ["coarse navigation / wide-volume tracking",   "≤ 50 mm · ≤ 5°",    f"{_verdict(rms_mm, 50.0)} ({rms_mm:.1f} mm vs 50 mm)"],
        ],
    ))
    lines.append("")
    lines.append(
        "Tolerance values above are conventional rules of thumb in robotics, not a contract. "
        "Your manager should overlay them with the specific task envelope and any safety margins."
    )
    lines.append("")

    lines.append("## 1. Capture summary")
    lines.append("")
    lines.append(_table(
        ["session", "n samples", "duration (s)", "rate (Hz)"],
        [
            ["motion / vive",   f"{motion_meta['n_vive']}",     f"{motion_meta['dur_vive']:.1f}", f"{motion_meta['rate_vive']:.1f}"],
            ["motion / umi",    f"{motion_meta['n_umi']}",      f"{motion_meta['dur_umi']:.1f}",  f"{motion_meta['rate_umi']:.1f}"],
            ["motion / synced", f"{sync_meta['n_pairs']}",      f"{sync_meta['span_s']:.1f}",     f"{sync_meta['rate']:.1f}"],
            ["static / vive",   f"{static_v['n']}",             f"{static_v['duration_s']:.1f}",  f"{static_v['rate_hz']:.1f}"],
            ["static / umi",    f"{static_u['n']}",             f"{static_u['duration_s']:.1f}",  f"{static_u['rate_hz']:.1f}"],
        ],
    ))
    lines.append("")
    lines.append(f"- Sync delta_t (umi → vive): **{sync_meta['delta_t']:+.4f} s**  (xcorr peak/mean SNR `{sync_meta['snr']:.2f}`)")
    lines.append(f"- Rotation diversity: vive **{sync_meta['vive_rot_deg']:.1f}°**, umi **{sync_meta['umi_rot_deg']:.1f}°** (≥30° per side recommended)")
    lines.append("")

    lines.append("## 2. Solver comparison — `cv2.calibrateHandEye`")
    lines.append("")
    rows = []
    for r in method_results:
        if r.ok:
            rows.append([
                r.method, "OK",
                f"{r.pos_stats['rms']:.3f}", f"{r.pos_stats['p95']:.3f}", f"{r.pos_stats['max']:.3f}",
                f"{r.rot_stats['rms']:.4f}", f"{r.rot_stats['p95']:.4f}", f"{r.rot_stats['max']:.4f}",
            ])
        else:
            rows.append([r.method, "FAIL", "—", "—", "—", "—", "—", "—"])
    lines.append(_table(
        ["method", "status", "pos RMS (mm)", "pos p95", "pos max", "rot RMS (deg)", "rot p95", "rot max"],
        rows,
    ))
    lines.append("")
    lines.append(f"![Position residual histograms]({figs}/residuals_pos_hist.png)")
    lines.append("")
    lines.append(f"![Rotation residual histograms]({figs}/residuals_rot_hist.png)")
    lines.append("")
    lines.append(f"![Method comparison]({figs}/method_compare.png)")
    lines.append("")

    lines.append(f"## 3. Solved `T_vive_umi`  —  best method: **{best.method}**")
    lines.append("")
    lines.append(f"Selected by lowest position RMS ({best.pos_stats['rms']:.3f} mm).")
    lines.append("")
    lines.append("```")
    lines.append(_fmt_T(best.T))
    lines.append("```")
    lines.append("")
    lines.append(_table(
        ["", "n", "mean", "RMS", "p50", "p95", "max", "unit"],
        [
            _stats_row("position", best.pos_stats, "mm"),
            _stats_row("rotation", best.rot_stats, "deg"),
        ],
    ))
    lines.append("")
    lines.append(f"![Per-pair residual time series]({figs}/residuals_timeseries.png)")
    lines.append("")
    lines.append(f"![Trajectory overlay]({figs}/trajectory.png)")
    lines.append("")

    # Drift decomposition — Vive-as-truth lens.
    p_pos = drift["position"]
    p_rot = drift["rotation"]
    lines.append("## 4. Vive as ground truth — UMI error decomposition")
    lines.append("")
    lines.append(
        "Same per-pair residual the solver minimises, re-interpreted: with the rigid mount and "
        "the solved `X` taken as fixed, any deviation is UMI's error. The magnitude time-series "
        "is fit with `y = bias + drift · t`; the standard deviation around that line is the "
        "per-frame noise."
    )
    lines.append("")
    lines.append(_table(
        ["component", "position", "rotation"],
        [
            ["bias (intercept at t=0)",      f"{p_pos['bias_mm']:.3f} mm",                   f"{p_rot['bias_deg']:.4f}°"],
            ["drift rate (slope)",           f"{p_pos['drift_mm_s']:+.4f} mm/s",             f"{p_rot['drift_deg_s']:+.5f}°/s"],
            ["drift over full window",       f"{p_pos['drift_mm_s'] * drift['duration_s']:+.3f} mm", f"{p_rot['drift_deg_s'] * drift['duration_s']:+.4f}°"],
            ["per-frame noise (1σ detrended)", f"{p_pos['noise_mm']:.3f} mm",                f"{p_rot['noise_deg']:.4f}°"],
            ["RMS magnitude",                f"{p_pos['rms_mm']:.3f} mm",                    f"{p_rot['rms_deg']:.4f}°"],
            ["max",                          f"{p_pos['max_mm']:.3f} mm",                    f"{p_rot['max_deg']:.4f}°"],
            ["window",                       f"{drift['duration_s']:.1f} s ({drift['n_pairs']} pairs)", "—"],
        ],
    ))
    lines.append("")
    lines.append("Per-axis position residual (signed, world frame):")
    lines.append("")
    rows_axis = []
    for axis in "xyz":
        ax = drift["per_axis"][axis]
        rows_axis.append([
            axis,
            f"{ax['bias_mm']:+.3f}",
            f"{ax['slope_mm_s']:+.4f}",
            f"{ax['slope_mm_s'] * drift['duration_s']:+.3f}",
            f"{ax['noise_mm']:.3f}",
            f"{ax['max_mm']:.3f}",
        ])
    lines.append(_table(
        ["axis", "bias (mm)", "drift (mm/s)", "drift over window (mm)", "noise 1σ (mm)", "|max| (mm)"],
        rows_axis,
    ))
    lines.append("")
    lines.append(f"![UMI residual vs time, with linear fit]({figs}/drift.png)")
    lines.append("")
    lines.append(f"![Per-axis residual]({figs}/drift_axes.png)")
    lines.append("")

    lines.append("## 5. Static-mount stability")
    lines.append("")
    lines.append(
        "With the rig set down and untouched, each tracking system is reporting its own "
        "residual noise. Lower bound on what the calibration can resolve."
    )
    lines.append("")
    lines.append(_table(
        ["stream", "σx mm", "σy mm", "σz mm", "‖p‖ p95 mm", "‖p‖ max mm", "rot σ deg", "rot p95 deg", "rot max deg"],
        [
            [
                "vive",
                f"{static_v['pos_sigma_mm']['x']:.4f}", f"{static_v['pos_sigma_mm']['y']:.4f}", f"{static_v['pos_sigma_mm']['z']:.4f}",
                f"{static_v['pos_sigma_mm']['p95']:.4f}", f"{static_v['pos_sigma_mm']['max']:.4f}",
                f"{static_v['rot_sigma_deg']['std']:.5f}", f"{static_v['rot_sigma_deg']['p95']:.5f}", f"{static_v['rot_sigma_deg']['max']:.5f}",
            ],
            [
                "umi",
                f"{static_u['pos_sigma_mm']['x']:.4f}", f"{static_u['pos_sigma_mm']['y']:.4f}", f"{static_u['pos_sigma_mm']['z']:.4f}",
                f"{static_u['pos_sigma_mm']['p95']:.4f}", f"{static_u['pos_sigma_mm']['max']:.4f}",
                f"{static_u['rot_sigma_deg']['std']:.5f}", f"{static_u['rot_sigma_deg']['p95']:.5f}", f"{static_u['rot_sigma_deg']['max']:.5f}",
            ],
        ],
    ))
    lines.append("")
    lines.append(f"![Static — vive]({figs}/static_vive.png)")
    lines.append("")
    lines.append(f"![Static — umi]({figs}/static_umi.png)")
    lines.append("")
    lines.append(f"![Static XY — vive]({figs}/static_xy_vive.png)")
    lines.append("")
    lines.append(f"![Static XY — umi]({figs}/static_xy_umi.png)")
    lines.append("")

    lines.append("## 6. Static cross-check  —  `T_vive · X`  vs  `T_umi`")
    lines.append("")
    if static_cross.get("n_pairs", 0) == 0:
        lines.append("_No paired static samples within the gap window._")
    else:
        lines.append(f"Paired n = **{static_cross['n_pairs']}**.")
        lines.append("")
        lines.append(_table(
            ["", "n", "mean", "RMS", "p50", "p95", "max", "unit"],
            [
                _stats_row("position", static_cross["pos_stats_mm"], "mm"),
                _stats_row("rotation", static_cross["rot_stats_deg"], "deg"),
            ],
        ))
        lines.append("")
        lines.append(f"![Static cross mismatch]({figs}/static_cross.png)")
    lines.append("")

    lines.append("## 7. Notes")
    lines.append("")
    lines.append(
        "- Hand-eye residuals here are **invariant residuals** — `Wᵢ = T_umi · X⁻¹ · T_vive⁻¹`, "
        "distance from the SVD-mean. They tell you how non-rigid the link looks within this "
        "session, not absolute accuracy."
    )
    lines.append(
        "- Static σ from a single tracker is dominated by that tracker's own jitter. To reduce "
        "it, average over a longer window or use a heavier mount."
    )
    lines.append(
        "- If method residuals diverge by orders of magnitude, suspect bad pair geometry "
        "(low rotation diversity, weak parallax) before suspecting the solver."
    )
    lines.append("")
    return "\n".join(lines)


# --- driver ---------------------------------------------------------------

def _ensure_synced(
    motion_dir: Path, out_data_dir: Path, max_pair_gap_s: float,
    delta_t_override: float | None, max_skew_s: float,
) -> tuple[list[dict], dict]:
    synced_path = motion_dir / "synced.json"
    if synced_path.exists() and delta_t_override is None:
        with open(synced_path) as f:
            doc = json.load(f)
        pairs = doc.get("samples") or []
        meta = doc.get("meta") or {}
        if not pairs:
            raise SystemExit(f"{synced_path}: no samples")
        ts = [p["ts"] for p in pairs]
        return pairs, {
            "delta_t": float(meta.get("delta_t", 0.0)),
            "snr": float("nan"),
            "vive_rot_deg": float(meta.get("a_rot_deg", meta.get("vive_rot_deg", 0.0))),
            "umi_rot_deg": float(meta.get("b_rot_deg", meta.get("umi_rot_deg", 0.0))),
            "n_pairs": len(pairs),
            "span_s": float(ts[-1] - ts[0]) if len(ts) > 1 else 0.0,
            "rate": float((len(ts) - 1) / (ts[-1] - ts[0])) if (len(ts) > 1 and ts[-1] > ts[0]) else 0.0,
        }
    vive = _load_samples(motion_dir / "vive.json")
    umi = _load_samples(motion_dir / "umi.json")
    res = sync_streams(
        vive, umi,
        max_skew_s=max_skew_s, max_pair_gap_s=max_pair_gap_s,
        delta_t_override=delta_t_override,
    )
    if not res["ok"]:
        raise SystemExit(f"sync failed: {res.get('reason')}")
    pairs = res["pairs"]
    out_data_dir.mkdir(parents=True, exist_ok=True)
    out = {
        "meta": {
            "kind": "synced", "n": res["n_pairs"], "delta_t": res["delta_t"],
            "a_rot_deg": res["vive_rot_deg"], "b_rot_deg": res["umi_rot_deg"],
        },
        "samples": pairs,
    }
    with open(out_data_dir / "synced.json", "w") as f:
        json.dump(out, f)
    ts = [p["ts"] for p in pairs]
    return pairs, {
        "delta_t": float(res["delta_t"]),
        "snr": float(res.get("snr", float("nan"))),
        "vive_rot_deg": float(res["vive_rot_deg"]),
        "umi_rot_deg": float(res["umi_rot_deg"]),
        "n_pairs": int(res["n_pairs"]),
        "span_s": float(ts[-1] - ts[0]) if len(ts) > 1 else 0.0,
        "rate": float((len(ts) - 1) / (ts[-1] - ts[0])) if (len(ts) > 1 and ts[-1] > ts[0]) else 0.0,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--motion-dir", required=True, type=Path)
    p.add_argument("--static-dir", required=True, type=Path)
    p.add_argument("--out-dir", default=REPO / "docs" / "precision", type=Path)
    p.add_argument("--methods", default=",".join(METHODS),
                   help=f"comma-separated subset of {METHODS}")
    p.add_argument("--pattern", default="eye_in_hand", choices=("eye_in_hand", "eye_to_hand"))
    p.add_argument("--max-pair-gap-s", default=0.05, type=float)
    p.add_argument("--delta-t-override", type=float, default=None,
                   help="skip cross-correlation; pair umi.ts + delta_t against vive.ts directly")
    p.add_argument("--max-skew-s", default=5.0, type=float,
                   help="cross-correlation lag window (only used when --delta-t-override is not set)")
    args = p.parse_args()

    methods = tuple(m.strip().lower() for m in args.methods.split(",") if m.strip())
    bad = [m for m in methods if m not in METHODS]
    if bad:
        sys.stderr.write(f"unknown methods: {bad} (allowed: {METHODS})\n")
        return 2

    out_dir: Path = args.out_dir
    figs_dir = out_dir / "figs"
    data_dir = out_dir / "data"
    figs_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    vive_motion = _load_samples(args.motion_dir / "vive.json")
    umi_motion = _load_samples(args.motion_dir / "umi.json")
    motion_meta = {
        "motion_dir": str(args.motion_dir),
        "n_vive": len(vive_motion),
        "n_umi": len(umi_motion),
        "dur_vive": float(vive_motion[-1]["ts"] - vive_motion[0]["ts"]),
        "dur_umi": float(umi_motion[-1]["ts"] - umi_motion[0]["ts"]),
        "rate_vive": (len(vive_motion) - 1) / max(1e-6, (vive_motion[-1]["ts"] - vive_motion[0]["ts"])),
        "rate_umi": (len(umi_motion) - 1) / max(1e-6, (umi_motion[-1]["ts"] - umi_motion[0]["ts"])),
    }
    pairs, sync_meta = _ensure_synced(
        args.motion_dir, data_dir, args.max_pair_gap_s,
        delta_t_override=args.delta_t_override, max_skew_s=args.max_skew_s,
    )
    method_results = _solve_all_methods(pairs, args.pattern, methods)
    best = _pick_best(method_results)
    if best is None:
        sys.stderr.write("all solvers failed; check input data\n")
        return 1

    vive_static = _load_samples(args.static_dir / "vive.json")
    umi_static = _load_samples(args.static_dir / "umi.json")
    static_v = _static_stream_stats(vive_static)
    static_v["source_dir"] = str(args.static_dir)
    static_u = _static_stream_stats(umi_static)
    static_u["source_dir"] = str(args.static_dir)
    X = np.asarray(best.T, dtype=np.float64)
    static_cross = _static_cross_stats(vive_static, umi_static, X, args.max_pair_gap_s)
    drift = _drift_decomposition(pairs, X, args.pattern)

    _plot_method_residual_hist(method_results, figs_dir / "residuals_pos_hist.png", "pos")
    _plot_method_residual_hist(method_results, figs_dir / "residuals_rot_hist.png", "rot")
    _plot_method_compare(method_results, figs_dir / "method_compare.png")
    _plot_residual_timeseries(best, figs_dir / "residuals_timeseries.png")
    _plot_trajectory(pairs, X, figs_dir / "trajectory.png")
    _plot_static_pos(static_v, "vive", figs_dir / "static_vive.png")
    _plot_static_pos(static_u, "umi", figs_dir / "static_umi.png")
    _plot_static_xy(static_v, "vive", figs_dir / "static_xy_vive.png")
    _plot_static_xy(static_u, "umi", figs_dir / "static_xy_umi.png")
    _plot_static_cross(static_cross, figs_dir / "static_cross.png")
    _plot_drift(drift, figs_dir / "drift.png")
    _plot_drift_axes(drift, figs_dir / "drift_axes.png")

    light_v = {k: v for k, v in static_v.items() if k not in ("ts", "pos_mm", "rot_dev_deg")}
    light_u = {k: v for k, v in static_u.items() if k not in ("ts", "pos_mm", "rot_dev_deg")}
    light_cross = {k: v for k, v in static_cross.items() if k not in ("ts", "pos_mm", "rot_deg")}
    light_drift = {k: v for k, v in drift.items() if not k.startswith("_")}

    metrics = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "motion": motion_meta,
        "sync": sync_meta,
        "methods": [asdict(r) for r in method_results],
        "best": best.method,
        "T_vive_umi": best.T,
        "static_vive": light_v,
        "static_umi": light_u,
        "static_cross": light_cross,
        "drift": light_drift,
    }
    with open(data_dir / "metrics.json", "w") as f:
        json.dump(metrics, f, indent=2)

    md = render_markdown(motion_meta, sync_meta, method_results, best, static_v, static_u, static_cross, drift)
    (out_dir / "report.md").write_text(md)
    short_md = render_short_markdown(motion_meta, sync_meta, best, drift)
    (out_dir / "short_report.md").write_text(short_md)
    print(f"wrote {out_dir / 'report.md'}")
    print(f"     {out_dir / 'short_report.md'}")
    print(f"     {out_dir / 'data' / 'metrics.json'}")
    print(f"     {len(list(figs_dir.glob('*.png')))} figures in {figs_dir}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
