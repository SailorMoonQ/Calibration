"""Fish-eye intrinsics — wraps cv2.fisheye.calibrate (Kannala-Brandt / equidistant model).

cv2.fisheye requires all frames to expose the same number of corners — fine for a standard
chessboard, tricky for ChAruco with variable detection. For ChAruco we currently keep only
frames whose detected-corner count matches the most common count.

CALIB_CHECK_COND aborts the whole solve when any single frame is ill-conditioned (board
nearly fronto-parallel, low spread, etc.). Rather than disabling the check (which lets
those frames poison the solution), we parse the offending index out of the cv2 error
and drop just that frame, then retry. Loops until success or fewer than 4 frames remain."""
from __future__ import annotations

import logging
import re
from collections import Counter

import cv2
import numpy as np

from app.models import FisheyeRequest, CalibrationResult
from app.calib import _io

log = logging.getLogger("calib.fisheye")

_TERM = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-6)
_BAD_FRAME_RE = re.compile(r"input array (\d+)")
# cv2.fisheye::InitExtrinsics asserts `fabs(norm_u1) > 0` when the initial pose for a
# frame collapses to a degenerate triangle (corners near-collinear in undistorted space).
# The error doesn't carry a frame index, so we need leave-one-out to find the culprit.
_INIT_EXTR_HINTS = ("norm_u1", "InitExtrinsics")


def _is_init_extrinsics_error(msg: str) -> bool:
    return any(h in msg for h in _INIT_EXTR_HINTS)


def _uniform(detections: list[_io.Detection]) -> list[_io.Detection]:
    counts = Counter(len(d.corners) for d in detections)
    if not counts:
        return []
    (best_count, _n) = counts.most_common(1)[0]
    return [d for d in detections if len(d.corners) == best_count]


def _try_calibrate(uniform, image_size, flags):
    """Single cv2.fisheye.calibrate call. Returns (rms, K, D, rvecs, tvecs) or raises cv2.error."""
    obj_pts = [d.object_points.reshape(-1, 1, 3).astype(np.float64) for d in uniform]
    img_pts = [d.corners.reshape(-1, 1, 2).astype(np.float64) for d in uniform]
    K = np.zeros((3, 3))
    D = np.zeros((4, 1))
    rvecs = [np.zeros((1, 1, 3), dtype=np.float64) for _ in uniform]
    tvecs = [np.zeros((1, 1, 3), dtype=np.float64) for _ in uniform]
    rms, K, D, rvecs, tvecs = cv2.fisheye.calibrate(
        obj_pts, img_pts, image_size, K, D, rvecs, tvecs, flags, _TERM,
    )
    return rms, K, D, rvecs, tvecs


def _frame_spread(detection: _io.Detection) -> float:
    """2D bounding-box area of the detected corners — proxy for how 'well-conditioned'
    a single frame's pose estimate will be. Bigger = better. Used to put the most
    informative frame first so InitExtrinsics has a clean starting point."""
    pts = detection.corners
    if pts is None or len(pts) < 4:
        return 0.0
    return float((pts[:, 0].max() - pts[:, 0].min()) * (pts[:, 1].max() - pts[:, 1].min()))


def _find_bad_init_frame(uniform, image_size, flags) -> int | None:
    """Leave-one-out search for a frame whose removal fixes a norm_u1 / InitExtrinsics
    failure. Returns the index to drop, or None if no single removal helps."""
    for i in range(len(uniform)):
        candidate = uniform[:i] + uniform[i + 1:]
        if len(candidate) < 4:
            return None
        try:
            _try_calibrate(candidate, image_size, flags)
            return i
        except cv2.error as e:
            # Anything other than the same init-extrinsics error means this candidate
            # got *past* InitExtrinsics — that frame `i` was the culprit. We don't
            # need a successful calibrate, just to clear the init step.
            if not _is_init_extrinsics_error(str(e)):
                return i
    return None


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
    non_uniform = len(detections) - len(uniform)
    if len(uniform) < 4:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 4 frames with consistent corner count, got {len(uniform)}"
                    f" (detected {len(detections)}, skipped {len(skipped)})",
        )

    image_size = uniform[0].image_size
    # Put the frame with the largest 2D corner spread first. cv2.fisheye.calibrate's
    # InitExtrinsics is sensitive to the order of frames; a clean leading frame
    # often avoids singular initial-pose estimates downstream.
    uniform.sort(key=_frame_spread, reverse=True)
    flags = (
        cv2.fisheye.CALIB_RECOMPUTE_EXTRINSIC
        | cv2.fisheye.CALIB_CHECK_COND
        | cv2.fisheye.CALIB_FIX_SKEW
    )

    dropped: list[str] = []
    last_err: str = ""
    while True:
        try:
            rms, K, D, rvecs, tvecs = _try_calibrate(uniform, image_size, flags)
            break
        except cv2.error as e:
            last_err = str(e)
            m = _BAD_FRAME_RE.search(last_err)
            if m:
                idx = int(m.group(1))
                if 0 <= idx < len(uniform):
                    bad = uniform.pop(idx)
                    dropped.append(bad.path)
                    log.info("fisheye: dropped ill-conditioned frame %s (now %d remain)", bad.path, len(uniform))
                else:
                    return CalibrationResult(
                        ok=False, rms=0.0,
                        message=f"cv2.fisheye.calibrate flagged frame {idx} but only {len(uniform)} remain",
                    )
            elif _is_init_extrinsics_error(last_err):
                # No frame index in the message — leave-one-out hunt for the culprit.
                idx = _find_bad_init_frame(uniform, image_size, flags)
                if idx is None:
                    return CalibrationResult(
                        ok=False, rms=0.0,
                        message=f"cv2.fisheye.calibrate failed in InitExtrinsics and no single "
                                f"frame removal recovered it. {last_err.splitlines()[-1].strip()}",
                    )
                bad = uniform.pop(idx)
                dropped.append(bad.path)
                log.info("fisheye: dropped degenerate-pose frame %s (now %d remain)", bad.path, len(uniform))
            else:
                # Some other cv2 error — bubble up, the message is descriptive enough.
                return CalibrationResult(
                    ok=False, rms=0.0,
                    message=f"cv2.fisheye.calibrate failed: {last_err.splitlines()[-1].strip()}",
                )
            if len(uniform) < 4:
                return CalibrationResult(
                    ok=False, rms=0.0,
                    message=f"too many bad frames — only {len(uniform)} usable left "
                            f"(dropped {len(dropped)}). Last error: {last_err.splitlines()[-1].strip()}",
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

    total_skipped = len(skipped) + non_uniform + len(dropped)
    log.info(
        "fisheye rms=%.4f px · %d frames · %d skipped (%d undetected, %d non-uniform, %d ill-cond)",
        rms, len(uniform), total_skipped, len(skipped), non_uniform, len(dropped),
    )

    msg = f"fisheye/{req.model} · used {len(uniform)} frames · skipped {total_skipped}"
    if dropped:
        msg += f" (dropped {len(dropped)} ill-conditioned)"

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
        message=msg,
    )
