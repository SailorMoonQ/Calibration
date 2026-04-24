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
from dataclasses import dataclass
from typing import Iterable

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
    """Returns (N, 2) float32 corners or None. Uses the SB (sector-based) detector
    which is sub-pixel accurate without needing cornerSubPix."""
    flags = cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY
    found, corners = cv2.findChessboardCornersSB(gray, (cols, rows), flags)
    if not found:
        return None
    return corners.reshape(-1, 2).astype(np.float32)


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
    for d, rvec, tvec in zip(detections, rvecs, tvecs):
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
    for d, rvec, tvec in zip(detections, rvecs, tvecs):
        reproj, _ = cv2.projectPoints(d.object_points, rvec, tvec, K, D)
        reproj = reproj.reshape(-1, 2)
        diff = d.corners - reproj
        out.append([
            (float(d.corners[i, 0]), float(d.corners[i, 1]),
             float(diff[i, 0]), float(diff[i, 1]))
            for i in range(len(d.corners))
        ])
    return out
