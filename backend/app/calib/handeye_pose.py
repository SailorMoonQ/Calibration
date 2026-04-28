"""Hand-Eye AX=XB solver for pre-paired pose streams (no images, no solvePnP)."""
from __future__ import annotations

import logging
import math

import cv2
import numpy as np

from app.models import CalibrationResult

log = logging.getLogger("calib.handeye_pose")

_METHOD_FLAGS = {
    "tsai":       cv2.CALIB_HAND_EYE_TSAI,
    "park":       cv2.CALIB_HAND_EYE_PARK,
    "horaud":     cv2.CALIB_HAND_EYE_HORAUD,
    "andreff":    cv2.CALIB_HAND_EYE_ANDREFF,
    "daniilidis": cv2.CALIB_HAND_EYE_DANIILIDIS,
}


def _split(Ts: list[np.ndarray]) -> tuple[list[np.ndarray], list[np.ndarray]]:
    R = [T[:3, :3] for T in Ts]
    t = [T[:3, 3].reshape(3, 1) for T in Ts]
    return R, t


def _split_inv(Ts: list[np.ndarray]) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Return R, t for the inverses of each transform in Ts."""
    R = [T[:3, :3].T for T in Ts]
    t = [-(T[:3, :3].T @ T[:3, 3]).reshape(3, 1) for T in Ts]
    return R, t


def _per_pair_residuals(
    T_vive_list: list[np.ndarray], T_umi_list: list[np.ndarray], X: np.ndarray,
) -> tuple[list[float], list[float]]:
    Xinv = np.linalg.inv(X)
    Ws = [T_u @ Xinv @ np.linalg.inv(T_v) for T_v, T_u in zip(T_vive_list, T_umi_list)]
    Rs = np.array([W[:3, :3] for W in Ws])
    ts = np.array([W[:3, 3] for W in Ws])
    R_med = Rs.mean(axis=0)
    U, _, Vt = np.linalg.svd(R_med)
    R_ref = U @ np.diag([1, 1, np.linalg.det(U @ Vt)]) @ Vt
    t_ref = ts.mean(axis=0)
    angs = []
    pos_mm = []
    for W in Ws:
        dR = W[:3, :3].T @ R_ref
        cos_ang = (np.trace(dR) - 1.0) / 2.0
        ang = math.degrees(math.acos(float(np.clip(cos_ang, -1, 1))))
        dt_mm = 1000.0 * float(np.linalg.norm(W[:3, 3] - t_ref))
        angs.append(ang)
        pos_mm.append(dt_mm)
    return angs, pos_mm


def solve_handeye_pose(pairs: list[dict], method: str = "daniilidis") -> CalibrationResult:
    flag = _METHOD_FLAGS.get(method, cv2.CALIB_HAND_EYE_DANIILIDIS)
    if len(pairs) < 5:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 5 pairs, got {len(pairs)}",
        )
    T_vive = [np.asarray(p["T_vive"], dtype=np.float64) for p in pairs]
    T_umi = [np.asarray(p["T_umi"], dtype=np.float64) for p in pairs]
    # cv2.calibrateHandEye(R_gripper2base, t_gripper2base, R_target2cam, t_target2cam)
    # solves AX = XB and returns X = T_cam2gripper.
    # Our data satisfies: T_umi = W @ T_vive @ X_true.
    # Mapping: vive → gripper2base, inv(T_umi) → target2cam.
    # Under this mapping cv2 returns X_true directly.
    R_v, t_v = _split(T_vive)
    R_u_inv, t_u_inv = _split_inv(T_umi)
    try:
        R_X, t_X = cv2.calibrateHandEye(R_v, t_v, R_u_inv, t_u_inv, method=flag)
    except cv2.error as e:
        return CalibrationResult(ok=False, rms=0.0, message=f"cv2.calibrateHandEye failed: {e}")
    X = np.eye(4)
    X[:3, :3] = R_X
    X[:3, 3] = t_X.ravel()

    angs, pos_mm = _per_pair_residuals(T_vive, T_umi, X)
    rms_deg = float(np.sqrt(np.mean(np.square(angs))))
    log.info(
        "handeye_pose: %d pairs · rms %.3f° · pos rms %.2f mm (%s)",
        len(pairs), rms_deg, float(np.sqrt(np.mean(np.square(pos_mm)))), method,
    )
    return CalibrationResult(
        ok=True,
        rms=rms_deg,
        T=X.tolist(),
        per_frame_err=angs,
        iterations=0,
        final_cost=rms_deg ** 2 * len(pairs),
        message=f"{method}: {len(pairs)} pairs · pos rms {float(np.sqrt(np.mean(np.square(pos_mm)))):.2f} mm",
    )
