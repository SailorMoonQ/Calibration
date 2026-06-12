"""Shared helpers for the calibration modules: image loading, board geometry, board detection.

Conventions:
- `board.cols`, `board.rows` count *inner corners* for chessboards and squares for ChAruco,
  matching OpenCV's API.
- Object points are in board frame, Z=0, units of metres.
- Detected corners are returned as (N, 2) float32 arrays in pixel coordinates.
"""
from __future__ import annotations

import base64
import glob
import os
from collections.abc import Iterable
from dataclasses import dataclass

import cv2
import numpy as np

from app.models import Board

_IMAGE_EXTS = ("*.png", "*.jpg", "*.jpeg", "*.bmp", "*.tif", "*.tiff")

_ARUCO_DICTS = {
    "DICT_4X4_50":  cv2.aruco.DICT_4X4_50,
    "DICT_4X4_100": cv2.aruco.DICT_4X4_100,
    "DICT_5X5_50":  cv2.aruco.DICT_5X5_50,
    "DICT_5X5_100": cv2.aruco.DICT_5X5_100,
    "DICT_6X6_250": cv2.aruco.DICT_6X6_250,
    "DICT_7X7_250": cv2.aruco.DICT_7X7_250,
}


@dataclass
class Detection:
    path: str
    image_size: tuple[int, int]  # (w, h)
    corners: np.ndarray          # (N, 2) float32
    object_points: np.ndarray    # (N, 3) float32
    ids: np.ndarray | None = None


def list_dataset(path: str) -> list[str]:
    if not path or not os.path.isdir(path):
        return []
    out: list[str] = []
    for pat in _IMAGE_EXTS:
        out.extend(glob.glob(os.path.join(path, pat)))
        out.extend(glob.glob(os.path.join(path, pat.upper())))
    return sorted(set(out))


def load_image_gray(path: str) -> tuple[np.ndarray, tuple[int, int]]:
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(f"cannot read image: {path}")
    h, w = img.shape[:2]
    return img, (w, h)


def decode_b64_gray(b64: str) -> tuple[np.ndarray, tuple[int, int]]:
    raw = base64.b64decode(b64.split(",", 1)[-1])
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("could not decode image bytes")
    h, w = img.shape[:2]
    return img, (w, h)


def chess_object_points(cols: int, rows: int, sq: float) -> np.ndarray:
    objp = np.zeros((cols * rows, 3), dtype=np.float32)
    objp[:, :2] = np.mgrid[0:cols, 0:rows].T.reshape(-1, 2) * sq
    return objp


def detect_chessboard(gray: np.ndarray, cols: int, rows: int) -> np.ndarray | None:
    """Returns (N, 2) float32 corners or None.

    Primary: the SB (sector-based) detector — sub-pixel accurate without
    cornerSubPix. SB is precise but strict: on fisheye-periphery distortion or
    slight motion blur it often reports "not found", silently dropping otherwise
    usable frames (observed: 5/15 dropped on an arm-mounted fisheye set).

    Fallback: when SB misses, retry with the classic ADAPTIVE_THRESH detector +
    cornerSubPix. It tolerates the harder frames; sub-pixel refinement keeps the
    corners accurate enough for the solver. This recovers frames that would
    otherwise show up as "unused" (0.00) in the strip.
    """
    found, corners = cv2.findChessboardCornersSB(
        gray, (cols, rows), cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY
    )
    if found:
        return corners.reshape(-1, 2).astype(np.float32)

    found, corners = cv2.findChessboardCorners(
        gray, (cols, rows),
        cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE,
    )
    if not found:
        return None
    corners = cv2.cornerSubPix(
        gray, corners, (5, 5), (-1, -1),
        (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.01),
    )
    # CRITICAL: the classic detector enumerates corners from the OPPOSITE corner
    # vs SB — its order is the exact reverse (verified <1px reversed-match on every
    # frame where both succeed). chess_object_points() is built in SB's order, so a
    # fallback frame's corners must be reversed to line up; otherwise solvePnP gives
    # a 180°-flipped pose that, mixed with SB frames, wrecks the hand-eye solve
    # (observed 0.96° → 144°).
    corners = corners.reshape(-1, 2).astype(np.float32)[::-1]
    return np.ascontiguousarray(corners)


def _find_sb_live(gray: np.ndarray, cols: int, rows: int, max_dim: int) -> np.ndarray | None:
    """Single fast SB detection at a capped resolution; corners rescaled to full
    image coordinates. NORMALIZE only — no EXHAUSTIVE/ACCURACY (that's the solver path)."""
    h, w = gray.shape[:2]
    scale = min(1.0, max_dim / float(max(h, w)))
    small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1.0 else gray
    found, corners = cv2.findChessboardCornersSB(small, (cols, rows), cv2.CALIB_CB_NORMALIZE_IMAGE)
    if not found:
        return None
    return corners.reshape(-1, 2).astype(np.float32) / scale


def detect_chessboard_live(
    gray: np.ndarray, cols: int, rows: int,
    max_dim: int = 640, full_dim: int = 960, hi_res: bool = False,
) -> np.ndarray | None:
    """FAST, approximate chessboard detection for the LIVE PREVIEW only.

    Adaptive resolution by board position (the caller passes `hi_res=True` when the
    board was last seen near the fisheye FOV periphery):
      • central / unknown → detect on a `max_dim`-downscaled frame (cheap, keeps the
        overlay at video rate). A MISS is NOT retried at full-res: the common state
        is "no board in frame", and paying a full-res pass on every empty frame is
        what tanked the live frame rate.
      • peripheral (`hi_res`) → go straight to `full_dim`: at the fisheye edge the
        board is compressed/distorted and the downscale almost always misses it, so
        the fast pass would just be wasted work.

    The returned corners are coarse and are NEVER used by the solver — calibration
    always re-detects from the saved full-resolution images via `detect_chessboard`.
    This function does not touch that path.
    """
    return _find_sb_live(gray, cols, rows, full_dim if hi_res else max_dim)


def detect_charuco(gray: np.ndarray, board: Board) -> tuple[np.ndarray, np.ndarray] | None:
    if board.marker is None:
        raise ValueError("charuco board requires `marker` size")
    dict_id = _ARUCO_DICTS.get(board.dictionary, cv2.aruco.DICT_5X5_100)
    dictionary = cv2.aruco.getPredefinedDictionary(dict_id)
    cb = cv2.aruco.CharucoBoard((board.cols, board.rows), board.square, board.marker, dictionary)
    detector = cv2.aruco.CharucoDetector(cb)
    charuco_corners, charuco_ids, _marker_corners, _marker_ids = detector.detectBoard(gray)
    if charuco_corners is None or len(charuco_corners) < 8:
        return None
    # object points at the detected ids
    obj_all = cb.getChessboardCorners()  # (N, 3)
    ids = charuco_ids.reshape(-1)
    obj = obj_all[ids].astype(np.float32)
    img = charuco_corners.reshape(-1, 2).astype(np.float32)
    return img, obj


def detect_board(gray: np.ndarray, board: Board) -> tuple[np.ndarray, np.ndarray] | None:
    """Returns (image_points, object_points) or None. Unified across chess and charuco."""
    if board.type == "chess":
        corners = detect_chessboard(gray, board.cols, board.rows)
        if corners is None:
            return None
        return corners, chess_object_points(board.cols, board.rows, board.square)
    if board.type == "charuco":
        return detect_charuco(gray, board)
    raise ValueError(f"unknown board type: {board.type}")


def detect_board_live(gray: np.ndarray, board: Board, *, hi_res: bool = False) -> tuple[np.ndarray, np.ndarray] | None:
    """Like `detect_board`, but uses the fast approximate chessboard detector for
    live-preview overlays. `hi_res` hints that the board is near the FOV periphery,
    so the detector skips the doomed downscaled pass and goes straight to full-res.
    Charuco already detects partially/quickly, so it falls through to the normal
    path. Never feeds the solver."""
    if board.type == "chess":
        corners = detect_chessboard_live(gray, board.cols, board.rows, hi_res=hi_res)
        if corners is None:
            return None
        return corners, chess_object_points(board.cols, board.rows, board.square)
    return detect_board(gray, board)


def detect_many(paths: Iterable[str], board: Board) -> tuple[list[Detection], list[str]]:
    """Runs detection on every image path. Returns (detections, skipped_paths)."""
    detections: list[Detection] = []
    skipped: list[str] = []
    for p in paths:
        try:
            gray, size = load_image_gray(p)
        except FileNotFoundError:
            skipped.append(p)
            continue
        res = detect_board(gray, board)
        if res is None:
            skipped.append(p)
            continue
        img, obj = res
        detections.append(Detection(path=p, image_size=size, corners=img, object_points=obj))
    return detections, skipped


def per_frame_errors(
    detections: list[Detection],
    rvecs: list[np.ndarray],
    tvecs: list[np.ndarray],
    K: np.ndarray,
    D: np.ndarray,
) -> list[float]:
    errs: list[float] = []
    for d, rvec, tvec in zip(detections, rvecs, tvecs, strict=False):
        reproj, _ = cv2.projectPoints(d.object_points, rvec, tvec, K, D)
        reproj = reproj.reshape(-1, 2)
        err = float(np.linalg.norm(d.corners - reproj, axis=1).mean())
        errs.append(err)
    return errs


def per_frame_residuals(
    detections: list[Detection],
    rvecs: list[np.ndarray],
    tvecs: list[np.ndarray],
    K: np.ndarray,
    D: np.ndarray,
) -> list[list[tuple[float, float, float, float]]]:
    """Returns per-frame list of [(x, y, ex, ey), ...] where (ex, ey) = detected - reprojected."""
    out: list[list[tuple[float, float, float, float]]] = []
    for d, rvec, tvec in zip(detections, rvecs, tvecs, strict=False):
        reproj, _ = cv2.projectPoints(d.object_points, rvec, tvec, K, D)
        reproj = reproj.reshape(-1, 2)
        diff = d.corners - reproj
        out.append([
            (float(d.corners[i, 0]), float(d.corners[i, 1]),
             float(diff[i, 0]), float(diff[i, 1]))
            for i in range(len(d.corners))
        ])
    return out
