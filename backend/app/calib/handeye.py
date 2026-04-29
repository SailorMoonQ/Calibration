"""Hand-Eye AX=XB — wraps cv2.calibrateHandEye.

The same module handles both the HMD-mounted-camera case and the controller-held-board
case; the tab just picks which device supplies the `B` poses.

Inputs (dataset mode):
  - dataset_path: folder of images
  - poses_path:   JSON `{ "basename.jpg": [[4x4 row-major], ...], ... }` — T_base_tracker per frame
  - K, D:         camera intrinsics
  - board:        target geometry (board is static in the base/world frame)

A = T_cam_board (per-frame, via solvePnP)
B = T_base_tracker (per-frame, from the JSON)
cv2.calibrateHandEye → T_tracker_cam. Returned as 4x4 in CalibrationResult.T.
"""
from __future__ import annotations

import json
import logging
import os

import cv2
import numpy as np

from app.models import HandEyeRequest, CalibrationResult
from app.calib import _io

log = logging.getLogger("calib.handeye")

_METHOD_FLAGS = {
    "tsai":       cv2.CALIB_HAND_EYE_TSAI,
    "park":       cv2.CALIB_HAND_EYE_PARK,
    "horaud":     cv2.CALIB_HAND_EYE_HORAUD,
    "andreff":    cv2.CALIB_HAND_EYE_ANDREFF,
    "daniilidis": cv2.CALIB_HAND_EYE_DANIILIDIS,
}


def _split_poses(Ts: list[np.ndarray]) -> tuple[list[np.ndarray], list[np.ndarray]]:
    R = [T[:3, :3] for T in Ts]
    t = [T[:3, 3].reshape(3, 1) for T in Ts]
    return R, t


def _to_T(R: np.ndarray, t: np.ndarray) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = t.ravel()
    return T


def _load_poses_json(path: str) -> dict[str, np.ndarray]:
    """Read poses keyed by image basename. Accepts two per-entry shapes:

    - legacy:  basename -> 4x4 (or 3x4) nested list
    - new:     basename -> {"T": 4x4 nested list, "ts": float}  (ts optional)

    Returns a dict basename -> 4x4 numpy array. Timestamps are dropped here
    because the existing solver doesn't consume them; they live in the file
    for debug/resync tooling and round-trip cleanly via append_pose.
    """
    with open(path, "r") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError("poses JSON must be a dict keyed by image basename")
    out: dict[str, np.ndarray] = {}
    for k, v in raw.items():
        if isinstance(v, dict):
            if "T" not in v:
                raise ValueError(f"pose entry {k!r} missing 'T'")
            arr = v["T"]
        else:
            arr = v
        try:
            M = np.array(arr, dtype=np.float64)
        except (TypeError, ValueError) as e:
            raise ValueError(f"pose for {k!r} could not be parsed as a matrix: {e}")
        if M.shape == (4, 4):
            out[os.path.basename(k)] = M
        elif M.shape == (3, 4):
            T = np.eye(4); T[:3] = M; out[os.path.basename(k)] = T
        else:
            raise ValueError(f"pose for {k!r} must be 4x4 or 3x4, got {M.shape}")
    return out


def _build_A_from_dataset(req: HandEyeRequest) -> tuple[list[np.ndarray], list[str]]:
    """Per-frame T_cam_board via solvePnP. Returns (poses, matched_basenames)."""
    if not req.board:
        raise ValueError("board is required when using dataset_path")
    if req.K is None or req.D is None:
        raise ValueError("K and D are required when using dataset_path")
    paths = _io.list_dataset(req.dataset_path or "")
    if not paths:
        raise ValueError("dataset_path has no images")
    K = np.array(req.K, dtype=np.float64)
    D = np.array(req.D, dtype=np.float64).reshape(-1, 1)
    A: list[np.ndarray] = []
    names: list[str] = []
    for p in paths:
        try:
            gray, _sz = _io.load_image_gray(p)
        except FileNotFoundError:
            continue
        res = _io.detect_board(gray, req.board)
        if res is None:
            continue
        img, obj = res
        ok, rv, tv = cv2.solvePnP(
            obj.reshape(-1, 1, 3).astype(np.float64),
            img.reshape(-1, 1, 2).astype(np.float64),
            K, D, flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not ok:
            continue
        R, _ = cv2.Rodrigues(rv)
        A.append(_to_T(R, tv))
        names.append(os.path.basename(p))
    return A, names


def _match_AB(req: HandEyeRequest) -> tuple[list[np.ndarray], list[np.ndarray], list[str]]:
    if req.dataset_path and req.poses_path:
        A_all, names = _build_A_from_dataset(req)
        pose_map = _load_poses_json(req.poses_path)
        A: list[np.ndarray] = []
        B: list[np.ndarray] = []
        matched: list[str] = []
        for T_a, name in zip(A_all, names):
            if name in pose_map:
                A.append(T_a)
                B.append(pose_map[name])
                matched.append(name)
        return A, B, matched
    # inline fallback
    A = [np.array(m, dtype=np.float64) for m in req.A]
    B = [np.array(m, dtype=np.float64) for m in req.B]
    return A, B, [f"frame_{i:04d}" for i in range(len(A))]


def _consistency(X: np.ndarray, A: list[np.ndarray], B: list[np.ndarray]) -> tuple[float, float]:
    """With X fixed, T_base_board = B_i · X · A_i should be identical across frames.
    Returns (rot_rms_deg, trans_rms_mm) across frames vs the median pose."""
    if len(A) < 2:
        return 0.0, 0.0
    worlds = [B_i @ X @ A_i for A_i, B_i in zip(A, B)]
    ref = worlds[len(worlds) // 2]
    rot_errs: list[float] = []
    trans_errs: list[float] = []
    for W in worlds:
        dR = ref[:3, :3].T @ W[:3, :3]
        # angle from trace (clipped for numerical safety)
        c = (np.trace(dR) - 1.0) * 0.5
        ang = float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))
        rot_errs.append(ang)
        dt = ref[:3, 3] - W[:3, 3]
        trans_errs.append(float(np.linalg.norm(dt) * 1000.0))  # mm
    rot_rms = float(np.sqrt(np.mean(np.square(rot_errs))))
    trans_rms = float(np.sqrt(np.mean(np.square(trans_errs))))
    return rot_rms, trans_rms


def calibrate(req: HandEyeRequest) -> CalibrationResult:
    try:
        A, B, names = _match_AB(req)
    except (ValueError, FileNotFoundError, json.JSONDecodeError) as e:
        return CalibrationResult(ok=False, rms=0.0, message=f"hand-eye input error: {e}")

    if len(A) != len(B) or len(A) < 3:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 3 matched A/B pairs, got A={len(A)}, B={len(B)}.",
        )

    R_A, t_A = _split_poses(A)
    R_B, t_B = _split_poses(B)

    flag = _METHOD_FLAGS.get(req.method, cv2.CALIB_HAND_EYE_PARK)
    try:
        R_X, t_X = cv2.calibrateHandEye(R_B, t_B, R_A, t_A, method=flag)
    except cv2.error as e:
        return CalibrationResult(ok=False, rms=0.0, message=f"cv2.calibrateHandEye failed: {e}")

    X = _to_T(R_X, t_X)
    rot_rms, trans_rms = _consistency(X, A, B)

    # per-frame "error" surfaced via per_frame_err = |W_i - ref| in mm for a quick histogram.
    per_frame_err: list[float] = []
    if len(A) >= 2:
        worlds = [B_i @ X @ A_i for A_i, B_i in zip(A, B)]
        ref = worlds[len(worlds) // 2]
        for W in worlds:
            per_frame_err.append(float(np.linalg.norm(ref[:3, 3] - W[:3, 3]) * 1000.0))

    log.info("handeye(%s/%s) pairs=%d · rot_rms=%.3f° trans_rms=%.2fmm",
             req.kind, req.method, len(A), rot_rms, trans_rms)

    return CalibrationResult(
        ok=True,
        rms=float(rot_rms),           # primary scalar: rotational consistency (degrees)
        T=X.tolist(),
        per_frame_err=per_frame_err,
        per_frame_residuals=[],
        detected_paths=names,
        iterations=len(A),
        final_cost=float(trans_rms),  # overloaded: translational RMS in mm
        message=f"handeye/{req.method} · {len(A)} pairs · rot {rot_rms:.3f}° · trans {trans_rms:.2f} mm",
    )
