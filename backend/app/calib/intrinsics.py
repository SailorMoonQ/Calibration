"""Pinhole intrinsics calibration — wraps cv2.calibrateCamera."""
from __future__ import annotations

import logging
import cv2
import numpy as np

from app.models import Board, DetectResponse, IntrinsicsRequest, CalibrationResult
from app.calib import _io

log = logging.getLogger("calib.intrinsics")

_MODEL_FLAGS = {
    "pinhole-k3": 0,
    "pinhole-k5": cv2.CALIB_RATIONAL_MODEL,
    "pinhole-rt": cv2.CALIB_RATIONAL_MODEL | cv2.CALIB_THIN_PRISM_MODEL,
}


def detect_board(image_b64: str, board: Board) -> DetectResponse:
    gray, size = _io.decode_b64_gray(image_b64)
    res = _io.detect_board(gray, board)
    if res is None:
        return DetectResponse(detected=False, corners=[], image_size=size)
    img, _obj = res
    return DetectResponse(
        detected=True,
        corners=[(float(x), float(y)) for x, y in img],
        image_size=size,
    )


def detect_board_file(path: str, board: Board) -> DetectResponse:
    gray, size = _io.load_image_gray(path)
    res = _io.detect_board(gray, board)
    if res is None:
        return DetectResponse(detected=False, corners=[], image_size=size)
    img, _obj = res
    return DetectResponse(
        detected=True,
        corners=[(float(x), float(y)) for x, y in img],
        image_size=size,
    )


def calibrate(req: IntrinsicsRequest) -> CalibrationResult:
    paths = _io.list_dataset(req.dataset_path) if req.dataset_path else []
    if not paths and not req.frames_b64:
        return CalibrationResult(ok=False, rms=0.0, message="no frames provided")

    # Detect on disk images (preferred) or fall back to b64 payloads.
    if paths:
        detections, skipped = _io.detect_many(paths, req.board)
    else:
        detections, skipped = [], []
        for i, b64 in enumerate(req.frames_b64):
            try:
                gray, size = _io.decode_b64_gray(b64)
            except Exception:
                skipped.append(f"frame[{i}]")
                continue
            res = _io.detect_board(gray, req.board)
            if res is None:
                skipped.append(f"frame[{i}]")
                continue
            img, obj = res
            detections.append(_io.Detection(
                path=f"frame[{i}]", image_size=size, corners=img, object_points=obj,
            ))

    if len(detections) < 4:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 4 frames with a detected board, got {len(detections)}"
                    f" (skipped {len(skipped)})",
        )

    image_size = detections[0].image_size
    object_points = [d.object_points for d in detections]
    image_points = [d.corners for d in detections]

    flags = _MODEL_FLAGS.get(req.model, 0)
    if req.fix_aspect:
        flags |= cv2.CALIB_FIX_ASPECT_RATIO
    if not req.estimate_skew:
        flags |= cv2.CALIB_ZERO_TANGENT_DIST  # closest standard OpenCV flag to "no skew-ish"

    rms, K, D, rvecs, tvecs = cv2.calibrateCamera(
        object_points, image_points, image_size, None, None, flags=flags,
    )

    per_frame = _io.per_frame_errors(detections, rvecs, tvecs, K, D)
    residuals = _io.per_frame_residuals(detections, rvecs, tvecs, K, D)

    log.info("intrinsics rms=%.4f px · %d frames · %d skipped", rms, len(detections), len(skipped))

    return CalibrationResult(
        ok=True,
        rms=float(rms),
        K=K.tolist(),
        D=D.reshape(-1).tolist(),
        image_size=image_size,
        per_frame_err=per_frame,
        per_frame_residuals=residuals,
        detected_paths=[d.path for d in detections],
        iterations=0,  # cv2.calibrateCamera does not expose iteration count
        final_cost=float(rms) ** 2 * len(detections),
        message=f"used {len(detections)} frames · skipped {len(skipped)}",
    )
