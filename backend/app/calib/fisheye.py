"""Fish-eye intrinsics — wraps cv2.fisheye.calibrate (Kannala-Brandt / equidistant model).

cv2.fisheye requires all frames to expose the same number of corners — fine for a standard
chessboard, tricky for ChAruco with variable detection. For ChAruco we currently keep only
frames whose detected-corner count matches the most common count."""
from __future__ import annotations

import logging
from collections import Counter

import cv2
import numpy as np

from app.models import FisheyeRequest, CalibrationResult
from app.calib import _io

log = logging.getLogger("calib.fisheye")

_TERM = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-6)


def _uniform(detections: list[_io.Detection]) -> list[_io.Detection]:
    counts = Counter(len(d.corners) for d in detections)
    if not counts:
        return []
    (best_count, _n) = counts.most_common(1)[0]
    return [d for d in detections if len(d.corners) == best_count]


def calibrate(req: FisheyeRequest) -> CalibrationResult:
    if req.model == "omni":
        return CalibrationResult(
            ok=False, rms=0.0, message="omni (Mei) model is not wired yet — use 'equidistant' / 'kb'.",
        )

    paths = _io.list_dataset(req.dataset_path) if req.dataset_path else []
    if not paths:
        return CalibrationResult(ok=False, rms=0.0, message="no frames — set dataset_path.")

    detections, skipped = _io.detect_many(paths, req.board)
    uniform = _uniform(detections)
    if len(uniform) < 4:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 4 frames with consistent corner count, got {len(uniform)}"
                    f" (detected {len(detections)}, skipped {len(skipped)})",
        )

    image_size = uniform[0].image_size
    obj_pts = [d.object_points.reshape(-1, 1, 3).astype(np.float64) for d in uniform]
    img_pts = [d.corners.reshape(-1, 1, 2).astype(np.float64) for d in uniform]

    K = np.zeros((3, 3))
    D = np.zeros((4, 1))
    rvecs = [np.zeros((1, 1, 3), dtype=np.float64) for _ in uniform]
    tvecs = [np.zeros((1, 1, 3), dtype=np.float64) for _ in uniform]

    flags = (
        cv2.fisheye.CALIB_RECOMPUTE_EXTRINSIC
        | cv2.fisheye.CALIB_CHECK_COND
        | cv2.fisheye.CALIB_FIX_SKEW
    )

    try:
        rms, K, D, rvecs, tvecs = cv2.fisheye.calibrate(
            obj_pts, img_pts, image_size, K, D, rvecs, tvecs, flags, _TERM,
        )
    except cv2.error as e:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"cv2.fisheye.calibrate failed: {e}. Try more frames or less skew.",
        )

    per_frame_err: list[float] = []
    residuals: list[list[tuple[float, float, float, float]]] = []
    for d, rvec, tvec in zip(uniform, rvecs, tvecs):
        reproj, _ = cv2.fisheye.projectPoints(
            d.object_points.reshape(-1, 1, 3).astype(np.float64), rvec, tvec, K, D,
        )
        reproj = reproj.reshape(-1, 2)
        diff = d.corners - reproj.astype(np.float32)
        per_frame_err.append(float(np.linalg.norm(diff, axis=1).mean()))
        residuals.append([
            (float(d.corners[i, 0]), float(d.corners[i, 1]),
             float(diff[i, 0]), float(diff[i, 1]))
            for i in range(len(d.corners))
        ])

    log.info("fisheye rms=%.4f px · %d frames · %d skipped", rms, len(uniform), len(skipped))

    return CalibrationResult(
        ok=True,
        rms=float(rms),
        K=K.tolist(),
        D=D.reshape(-1).tolist(),          # k1, k2, k3, k4
        image_size=image_size,
        per_frame_err=per_frame_err,
        per_frame_residuals=residuals,
        detected_paths=[d.path for d in uniform],
        iterations=30,
        final_cost=float(rms) ** 2 * len(uniform),
        message=f"fisheye/{req.model} · used {len(uniform)} frames · skipped {len(skipped) + (len(detections) - len(uniform))}",
    )
