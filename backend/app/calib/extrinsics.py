"""Stereo / multi-camera extrinsics — wraps cv2.stereoCalibrate.

Expects per-camera intrinsics already solved (CALIB_FIX_INTRINSIC); the fit only
recovers the rigid transform T_cam0_cam1. Pairs frames across two dataset folders
by filename match. For ChAruco boards, only corners detected in *both* images at
the same charuco IDs are kept (stereoCalibrate needs matching point count per pair).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import cv2
import numpy as np

from app.models import ExtrinsicsRequest, CalibrationResult, Board
from app.calib import _io

log = logging.getLogger("calib.extrinsics")

_TERM = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 60, 1e-6)


@dataclass
class _StereoPair:
    path0: str
    path1: str
    image_size: tuple[int, int]
    obj: np.ndarray   # (N, 3) float32
    img0: np.ndarray  # (N, 2) float32
    img1: np.ndarray  # (N, 2) float32


def _detect_with_ids(gray: np.ndarray, board: Board):
    """Returns (image_points, object_points, ids) or None. ids is None for chess."""
    if board.type == "chess":
        corners = _io.detect_chessboard(gray, board.cols, board.rows)
        if corners is None:
            return None
        obj = _io.chess_object_points(board.cols, board.rows, board.square)
        return corners, obj, None
    if board.type == "charuco":
        if board.marker is None:
            raise ValueError("charuco board requires `marker` size")
        dict_id = _io._ARUCO_DICTS.get(board.dictionary, cv2.aruco.DICT_5X5_100)
        dictionary = cv2.aruco.getPredefinedDictionary(dict_id)
        cb = cv2.aruco.CharucoBoard((board.cols, board.rows), board.square, board.marker, dictionary)
        detector = cv2.aruco.CharucoDetector(cb)
        cc, cids, _mc, _mi = detector.detectBoard(gray)
        if cc is None or cids is None or len(cc) < 6:
            return None
        obj_all = cb.getChessboardCorners()
        ids = cids.reshape(-1).astype(np.int32)
        obj = obj_all[ids].astype(np.float32)
        img = cc.reshape(-1, 2).astype(np.float32)
        return img, obj, ids
    raise ValueError(f"unknown board type: {board.type}")


def _pair_datasets(dir0: str, dir1: str) -> list[tuple[str, str]]:
    paths0 = _io.list_dataset(dir0)
    paths1 = _io.list_dataset(dir1)
    if not paths0 or not paths1:
        return []
    by_name1 = {os.path.basename(p): p for p in paths1}
    return [(p, by_name1[os.path.basename(p)]) for p in paths0 if os.path.basename(p) in by_name1]


def _build_pairs(pair_paths: list[tuple[str, str]], board: Board) -> tuple[list[_StereoPair], int]:
    pairs: list[_StereoPair] = []
    skipped = 0
    for p0, p1 in pair_paths:
        try:
            g0, size0 = _io.load_image_gray(p0)
            g1, size1 = _io.load_image_gray(p1)
        except FileNotFoundError:
            skipped += 1
            continue
        if size0 != size1:
            skipped += 1
            continue
        d0 = _detect_with_ids(g0, board)
        d1 = _detect_with_ids(g1, board)
        if d0 is None or d1 is None:
            skipped += 1
            continue
        i0, o0, ids0 = d0
        i1, o1, ids1 = d1
        if ids0 is None or ids1 is None:
            # chessboard: matching is positional; both sides must have identical counts.
            if len(i0) != len(i1):
                skipped += 1
                continue
            obj = o0
            img0 = i0
            img1 = i1
        else:
            # charuco: intersect detected ids
            common, sel0, sel1 = np.intersect1d(ids0, ids1, return_indices=True)
            if len(common) < 6:
                skipped += 1
                continue
            img0 = i0[sel0]
            img1 = i1[sel1]
            obj = o0[sel0]  # o0 is already id-indexed from _detect_with_ids
        pairs.append(_StereoPair(
            path0=p0, path1=p1, image_size=size0,
            obj=obj.astype(np.float32), img0=img0.astype(np.float32), img1=img1.astype(np.float32),
        ))
    return pairs, skipped


def calibrate(req: ExtrinsicsRequest) -> CalibrationResult:
    if not req.dataset_path_0 or not req.dataset_path_1:
        return CalibrationResult(ok=False, rms=0.0, message="set both dataset_path_0 and dataset_path_1.")

    pair_paths = _pair_datasets(req.dataset_path_0, req.dataset_path_1)
    if not pair_paths:
        return CalibrationResult(
            ok=False, rms=0.0,
            message="no filename-matched pairs between the two folders — snap with consistent names.",
        )

    pairs, skipped = _build_pairs(pair_paths, req.board)
    if len(pairs) < 4:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"need ≥ 4 pairs with board detected in both, got {len(pairs)} (skipped {skipped}).",
        )

    image_size = pairs[0].image_size
    obj_pts = [p.obj.reshape(-1, 1, 3).astype(np.float64) for p in pairs]
    img0_pts = [p.img0.reshape(-1, 1, 2).astype(np.float64) for p in pairs]
    img1_pts = [p.img1.reshape(-1, 1, 2).astype(np.float64) for p in pairs]

    K0 = np.array(req.K0, dtype=np.float64)
    K1 = np.array(req.K1, dtype=np.float64)
    D0 = np.array(req.D0, dtype=np.float64).reshape(-1, 1)
    D1 = np.array(req.D1, dtype=np.float64).reshape(-1, 1)

    flags = cv2.CALIB_FIX_INTRINSIC

    try:
        rms, _K0o, _D0o, _K1o, _D1o, R, T, _E, _F = cv2.stereoCalibrate(
            obj_pts, img0_pts, img1_pts, K0, D0, K1, D1, image_size,
            flags=flags, criteria=_TERM,
        )
    except cv2.error as e:
        return CalibrationResult(
            ok=False, rms=0.0,
            message=f"cv2.stereoCalibrate failed: {e}. Check intrinsics + pair count.",
        )

    Tmat = np.eye(4, dtype=np.float64)
    Tmat[:3, :3] = R
    Tmat[:3, 3] = T.ravel()

    # Per-pair reprojection error in cam1: solve board pose in cam0, transform, project.
    per_frame_err: list[float] = []
    residuals: list[list[tuple[float, float, float, float]]] = []
    for p in pairs:
        obj = p.obj.reshape(-1, 1, 3).astype(np.float64)
        img0 = p.img0.reshape(-1, 1, 2).astype(np.float64)
        ok, rv, tv = cv2.solvePnP(obj, img0, K0, D0, flags=cv2.SOLVEPNP_ITERATIVE)
        if not ok:
            per_frame_err.append(0.0)
            residuals.append([])
            continue
        R0, _ = cv2.Rodrigues(rv)
        T0 = np.eye(4); T0[:3, :3] = R0; T0[:3, 3] = tv.ravel()
        T1 = Tmat @ T0
        rv1, _ = cv2.Rodrigues(T1[:3, :3])
        tv1 = T1[:3, 3]
        reproj, _ = cv2.projectPoints(obj, rv1, tv1, K1, D1)
        reproj = reproj.reshape(-1, 2)
        diff = p.img1 - reproj.astype(np.float32)
        per_frame_err.append(float(np.linalg.norm(diff, axis=1).mean()))
        residuals.append([
            (float(p.img1[i, 0]), float(p.img1[i, 1]),
             float(diff[i, 0]), float(diff[i, 1]))
            for i in range(len(p.img1))
        ])

    log.info("stereo rms=%.4f px · %d pairs · %d skipped", rms, len(pairs), skipped)

    return CalibrationResult(
        ok=True,
        rms=float(rms),
        K=K1.tolist(),                         # target-camera K (cam1) for convenience
        D=D1.reshape(-1).tolist(),
        T=Tmat.tolist(),
        image_size=image_size,
        per_frame_err=per_frame_err,
        per_frame_residuals=residuals,
        detected_paths=[p.path0 for p in pairs],  # left-camera paths (viewport references left)
        iterations=60,
        final_cost=float(rms) ** 2 * len(pairs),
        message=f"stereo · {len(pairs)} pairs · skipped {skipped}",
    )
