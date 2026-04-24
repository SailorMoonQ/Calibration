"""Rigid-link chain solver.

Given two per-frame pose JSONs (basename → 4x4 T_base_<device>), recover the
rigid link T_a_b such that T_base_b(f) ≈ T_base_a(f) · T_a_b for every frame.

The estimator averages per-frame deltas D_f = inv(T_a(f)) · T_b(f):
  - translation component: arithmetic mean
  - rotation component: SE(3) chordal mean via SVD projection onto SO(3)
    R̂ = U · diag(1, 1, det(U·Vᵀ)) · Vᵀ   where M = Σ R_f,  M = U·Σ·Vᵀ

Per-frame residuals are then reported in mm (‖Δt‖) and degrees (angle of ΔR).
This is equivalent to the closed-form Procrustes solution for fixed-translation
rotation averaging; for our use case (rigidly mounted trackers) it is sufficient.
"""
from __future__ import annotations

import json
import logging
import os

import cv2
import numpy as np

from app.models import ChainRequest, LinkRequest, CalibrationResult

log = logging.getLogger("calib.chain")


def _load_poses_json(path: str) -> dict[str, np.ndarray]:
    with open(path, "r") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError(f"poses JSON {path!r} must be a dict keyed by basename")
    out: dict[str, np.ndarray] = {}
    for k, v in raw.items():
        M = np.array(v, dtype=np.float64)
        if M.shape == (4, 4):
            out[os.path.basename(k)] = M
        elif M.shape == (3, 4):
            T = np.eye(4); T[:3] = M; out[os.path.basename(k)] = T
        else:
            raise ValueError(f"pose for {k!r} must be 4x4 or 3x4, got {M.shape}")
    return out


def _project_to_SO3(M: np.ndarray) -> np.ndarray:
    U, _, Vt = np.linalg.svd(M)
    # enforce right-handed coordinate system
    d = np.sign(np.linalg.det(U @ Vt))
    D = np.diag([1.0, 1.0, d if d != 0 else 1.0])
    return U @ D @ Vt


def _angle_deg(R: np.ndarray) -> float:
    c = (np.trace(R) - 1.0) * 0.5
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def _as_pose_dict(raw: dict[str, list[list[float]]]) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for k, v in raw.items():
        M = np.array(v, dtype=np.float64)
        if M.shape == (4, 4):
            out[str(k)] = M
        elif M.shape == (3, 4):
            T = np.eye(4); T[:3] = M; out[str(k)] = T
        else:
            raise ValueError(f"pose for {k!r} must be 4x4 or 3x4, got {M.shape}")
    return out


def _solve_rigid_link(
    poses_a: dict[str, np.ndarray],
    poses_b: dict[str, np.ndarray],
    label: str,
) -> CalibrationResult:
    common = sorted(set(poses_a) & set(poses_b))
    if len(common) < 2:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 2 matched samples, got {len(common)} (A:{len(poses_a)} B:{len(poses_b)}).",
        )

    deltas = [np.linalg.inv(poses_a[n]) @ poses_b[n] for n in common]
    R_sum = np.sum([D[:3, :3] for D in deltas], axis=0)
    R_hat = _project_to_SO3(R_sum)
    t_hat = np.mean([D[:3, 3] for D in deltas], axis=0)
    X = np.eye(4)
    X[:3, :3] = R_hat
    X[:3, 3] = t_hat

    per_frame_err: list[float] = []
    rot_errs_deg: list[float] = []
    trans_errs_mm: list[float] = []
    for n in common:
        T_b_hat = poses_a[n] @ X
        dR = T_b_hat[:3, :3].T @ poses_b[n][:3, :3]
        rot_errs_deg.append(_angle_deg(dR))
        dt_mm = float(np.linalg.norm(T_b_hat[:3, 3] - poses_b[n][:3, 3]) * 1000.0)
        trans_errs_mm.append(dt_mm)
        per_frame_err.append(dt_mm)

    rot_rms = float(np.sqrt(np.mean(np.square(rot_errs_deg))))
    trans_rms = float(np.sqrt(np.mean(np.square(trans_errs_mm))))

    log.info("link(%s) pairs=%d · rot_rms=%.3f° trans_rms=%.2fmm",
             label, len(common), rot_rms, trans_rms)

    return CalibrationResult(
        ok=True,
        rms=float(rot_rms),
        T=X.tolist(),
        per_frame_err=per_frame_err,
        per_frame_residuals=[],
        detected_paths=common,
        iterations=len(common),
        final_cost=float(trans_rms),
        message=f"link/{label} · {len(common)} pairs · rot {rot_rms:.3f}° · trans {trans_rms:.2f} mm",
    )


def calibrate(req: ChainRequest) -> CalibrationResult:
    try:
        poses_a = _load_poses_json(req.poses_a_path)
        poses_b = _load_poses_json(req.poses_b_path)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
        return CalibrationResult(ok=False, rms=0.0, message=f"chain input error: {e}")
    return _solve_rigid_link(poses_a, poses_b, req.link_label)


def calibrate_link(req: LinkRequest) -> CalibrationResult:
    try:
        poses_a = _as_pose_dict(req.poses_a)
        poses_b = _as_pose_dict(req.poses_b)
    except ValueError as e:
        return CalibrationResult(ok=False, rms=0.0, message=f"link input error: {e}")
    return _solve_rigid_link(poses_a, poses_b, req.link_label)
