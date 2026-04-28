from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import struct
import time
import cv2
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
import numpy as np

from app.sources import manager as source_manager

from app import __version__
from app.models import (
    Board, DetectRequest, DetectFileRequest, DetectResponse,
    IntrinsicsRequest, FisheyeRequest, ExtrinsicsRequest,
    HandEyeRequest, ChainRequest, LinkRequest, CalibrationResult, DatasetListResponse,
    CalibrationSavePayload, CalibrationLoadResponse,
)
from app.calib import intrinsics, fisheye, extrinsics, handeye, chain, _io
from app.utils import yaml_io

log = logging.getLogger("calib.api")
router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"ok": True, "version": __version__, "platform": platform.platform()}


@router.get("/sources")
async def list_sources() -> dict:
    cameras = source_manager.list_devices()
    return {
        "cameras": cameras,
        "steamvr": {"hmd": None, "bases": [], "trackers": []},
    }


@router.get("/stream/devices")
async def stream_devices() -> dict:
    return {"cameras": source_manager.list_devices()}


@router.get("/stream/info")
async def stream_info(device: str) -> dict:
    src = source_manager.get(device)
    try:
        src.wait_frame(timeout=2.0)
        return src.info()
    finally:
        source_manager.release(device)


@router.get("/stream/mjpeg")
async def stream_mjpeg(device: str, fps: int = 30, quality: int = 70):
    src = source_manager.get(device)
    if not src.wait_frame(timeout=3.0):
        source_manager.release(device)
        raise HTTPException(status_code=503, detail="camera did not produce a frame")
    boundary = b"--frame"
    min_interval = 1.0 / max(1, fps)  # upper cap on send rate, not a floor.

    async def gen():
        last_seq = -1
        last_sent = 0.0
        try:
            while True:
                # Wait for a *new* frame so we never resend stale content.
                while src._latest_seq == last_seq:
                    await asyncio.sleep(0.003)
                # Rate cap (do not over-serve past target fps).
                now = time.time()
                if last_sent and now - last_sent < min_interval:
                    await asyncio.sleep(min_interval - (now - last_sent))
                frame = src.read()
                if frame is None:
                    continue
                last_seq = src._latest_seq
                ok, buf = await asyncio.to_thread(
                    cv2.imencode, ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
                )
                if not ok:
                    continue
                yield (
                    boundary + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(buf.size).encode() + b"\r\n\r\n"
                    + buf.tobytes() + b"\r\n"
                )
                last_sent = time.time()
        except asyncio.CancelledError:
            pass
        finally:
            source_manager.release(device)

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache, no-store, private", "Pragma": "no-cache"},
    )


@router.get("/stream/mjpeg_rect")
async def stream_mjpeg_rect(
    device: str,
    fx: float, fy: float, cx: float, cy: float,
    k1: float = 0.0, k2: float = 0.0, k3: float = 0.0, k4: float = 0.0,
    k5: float = 0.0, k6: float = 0.0,
    p1: float = 0.0, p2: float = 0.0,
    model: str = "fisheye",
    balance: float = 0.5, fov_scale: float = 1.0,
    alpha: float = 0.5,
    method: str = "remap",
    fps: int = 30, quality: int = 70,
):
    """Live-rectified MJPEG. `model='fisheye'` uses cv2.fisheye.* with k1..k4 +
    balance/fov_scale; `model='pinhole'` uses cv2.* (non-fisheye) with the full
    Brown-Conrady [k1, k2, p1, p2, k3, k4, k5, k6] vector + alpha. Maps are built
    once from the first frame's image_size; flip a query param to rebuild."""
    method = method.lower()
    model = model.lower()
    if method not in ("remap", "undistort"):
        raise HTTPException(status_code=400, detail=f"unknown method: {method}")
    if model not in ("fisheye", "pinhole"):
        raise HTTPException(status_code=400, detail=f"unknown model: {model}")
    src = source_manager.get(device)
    if not src.wait_frame(timeout=3.0):
        source_manager.release(device)
        raise HTTPException(status_code=503, detail="camera did not produce a frame")

    probe = src.read()
    if probe is None:
        source_manager.release(device)
        raise HTTPException(status_code=503, detail="no frame yet")
    h, w = probe.shape[:2]
    K = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)
    if model == "fisheye":
        D = np.array([k1, k2, k3, k4], dtype=np.float64).reshape(-1, 1)
        new_K = _new_K("fisheye", K, D, w, h, balance=balance, fov_scale=fov_scale)
    else:
        D = np.array([k1, k2, p1, p2, k3, k4, k5, k6], dtype=np.float64).reshape(-1, 1)
        new_K = _new_K("pinhole", K, D, w, h, alpha=alpha)

    try:
        if method == "remap":
            if model == "fisheye":
                map1, map2 = cv2.fisheye.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
            else:
                map1, map2 = cv2.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
    except cv2.error as e:
        source_manager.release(device)
        raise HTTPException(status_code=400, detail=f"rectify init failed: {e}")

    boundary = b"--frame"
    min_interval = 1.0 / max(1, fps)

    async def gen():
        last_seq = -1
        last_sent = 0.0
        try:
            while True:
                while src._latest_seq == last_seq:
                    await asyncio.sleep(0.003)
                now = time.time()
                if last_sent and now - last_sent < min_interval:
                    await asyncio.sleep(min_interval - (now - last_sent))
                frame = src.read()
                if frame is None:
                    continue
                last_seq = src._latest_seq
                if method == "remap":
                    rect = cv2.remap(frame, map1, map2,
                                     interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
                elif model == "fisheye":
                    rect = cv2.fisheye.undistortImage(frame, K, D, Knew=new_K, new_size=(w, h))
                else:
                    rect = cv2.undistort(frame, K, D, None, new_K)
                ok, buf = await asyncio.to_thread(
                    cv2.imencode, ".jpg", rect, [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
                )
                if not ok:
                    continue
                yield (
                    boundary + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(buf.size).encode() + b"\r\n\r\n"
                    + buf.tobytes() + b"\r\n"
                )
                last_sent = time.time()
        except asyncio.CancelledError:
            pass
        finally:
            source_manager.release(device)

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache, no-store, private", "Pragma": "no-cache"},
    )


@router.post("/stream/snap")
async def stream_snap(body: dict) -> dict:
    device = body.get("device")
    out_dir = body.get("dir")
    if not device or not out_dir:
        raise HTTPException(status_code=400, detail="need device + dir")
    src = source_manager.get(device)
    try:
        if not src.wait_frame(timeout=3.0):
            raise HTTPException(status_code=503, detail="no frame yet")
        frame = src.read()
        if frame is None:
            raise HTTPException(status_code=503, detail="no frame yet")
        os.makedirs(out_dir, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        ms = int((time.time() % 1) * 1000)
        path = os.path.join(out_dir, f"snap_{ts}_{ms:03d}.jpg")
        ok = cv2.imwrite(path, frame)
        if not ok:
            raise HTTPException(status_code=500, detail=f"write failed: {path}")
        h, w = frame.shape[:2]
        return {"ok": True, "path": path, "image_size": [w, h]}
    finally:
        source_manager.release(device)


@router.post("/stream/snap_pair")
async def stream_snap_pair(body: dict) -> dict:
    """Snap both cameras with a shared filename. Required for stereo: the solver pairs by basename."""
    device0 = body.get("device0")
    device1 = body.get("device1")
    dir0 = body.get("dir0")
    dir1 = body.get("dir1")
    if not (device0 and device1 and dir0 and dir1):
        raise HTTPException(status_code=400, detail="need device0/device1 + dir0/dir1")
    src0 = source_manager.get(device0)
    src1 = source_manager.get(device1)
    try:
        if not (src0.wait_frame(timeout=3.0) and src1.wait_frame(timeout=3.0)):
            raise HTTPException(status_code=503, detail="one of the cameras produced no frame")
        f0 = src0.read()
        f1 = src1.read()
        if f0 is None or f1 is None:
            raise HTTPException(status_code=503, detail="no frame yet")
        os.makedirs(dir0, exist_ok=True)
        os.makedirs(dir1, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        ms = int((time.time() % 1) * 1000)
        name = f"pair_{ts}_{ms:03d}.jpg"
        p0 = os.path.join(dir0, name)
        p1 = os.path.join(dir1, name)
        ok0 = cv2.imwrite(p0, f0)
        ok1 = cv2.imwrite(p1, f1)
        if not (ok0 and ok1):
            raise HTTPException(status_code=500, detail="write failed")
        return {"ok": True, "path0": p0, "path1": p1,
                "image_size0": [f0.shape[1], f0.shape[0]],
                "image_size1": [f1.shape[1], f1.shape[0]]}
    finally:
        source_manager.release(device0)
        source_manager.release(device1)


@router.get("/dataset/list", response_model=DatasetListResponse)
async def dataset_list(path: str) -> DatasetListResponse:
    files = _io.list_dataset(path)
    return DatasetListResponse(path=path, count=len(files), files=files)


@router.get("/dataset/frame")
async def dataset_frame(path: str):
    """Serve a single image by absolute path. Called by the renderer to show frame previews."""
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path)


def _new_K(model: str, K: np.ndarray, D: np.ndarray, w: int, h: int, **kwargs) -> np.ndarray:
    """Pick the new camera matrix for rectification, dispatching by model.

    Each branch falls back to scaling K's own focal and recentring if the
    OpenCV estimator returns a degenerate matrix (fx<1 or fy<1) — keeps the
    rectified preview sensible even when the distortion vector is bad."""
    if model == "fisheye":
        balance = float(kwargs.get("balance", 0.5))
        fov_scale = float(kwargs.get("fov_scale", 1.0))
        try:
            nK = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(
                K, D, (w, h), np.eye(3), balance=balance, fov_scale=fov_scale,
            )
        except cv2.error:
            nK = None
        if nK is None or nK[0, 0] < 1.0 or nK[1, 1] < 1.0:
            nK = K.copy()
            nK[0, 0] *= fov_scale
            nK[1, 1] *= fov_scale
            nK[0, 2] = w / 2.0
            nK[1, 2] = h / 2.0
        return nK
    if model == "pinhole":
        alpha_raw = float(kwargs.get("alpha", 0.5))
        alpha = max(0.0, min(1.0, alpha_raw))
        try:
            nK, _roi = cv2.getOptimalNewCameraMatrix(K, D, (w, h), alpha)
        except cv2.error:
            nK = None
        if nK is None or nK[0, 0] < 1.0 or nK[1, 1] < 1.0:
            nK = K.copy()
            nK[0, 2] = w / 2.0
            nK[1, 2] = h / 2.0
        return np.asarray(nK, dtype=np.float64)
    raise ValueError(f"unknown model: {model!r}")


_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")


@router.post("/dataset/delete")
async def dataset_delete(body: dict):
    """Soft-delete: move the file into <dataset_dir>/.trash/ so the renderer can undo
    the action by hitting /dataset/restore. Restricted to image extensions so a stray
    POST with `path: '/etc/passwd'` can't move arbitrary files."""
    path = body.get("path")
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="not found")
    ext = os.path.splitext(path)[1].lower()
    if ext not in _IMAGE_EXTS:
        raise HTTPException(status_code=400, detail=f"refusing to delete non-image: {ext}")
    parent = os.path.dirname(path)
    trash_dir = os.path.join(parent, ".trash")
    base = os.path.basename(path)
    try:
        os.makedirs(trash_dir, exist_ok=True)
        dest = os.path.join(trash_dir, base)
        if os.path.exists(dest):
            stem, suf = os.path.splitext(base)
            dest = os.path.join(trash_dir, f"{stem}_{int(time.time() * 1000)}{suf}")
        os.rename(path, dest)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"delete failed: {e}")
    return {"ok": True, "path": path, "trash_path": dest}


@router.post("/dataset/restore")
async def dataset_restore(body: dict):
    """Move a file out of the trash back to its original dataset path. Used by the
    renderer's undo flow. Both paths are validated to image extensions."""
    trash_path = body.get("trash_path")
    original = body.get("original_path")
    if not trash_path or not os.path.isfile(trash_path):
        raise HTTPException(status_code=404, detail="trash file not found")
    if not original:
        raise HTTPException(status_code=400, detail="need original_path")
    for p in (trash_path, original):
        if os.path.splitext(p)[1].lower() not in _IMAGE_EXTS:
            raise HTTPException(status_code=400, detail=f"non-image path: {p}")
    if os.path.exists(original):
        raise HTTPException(status_code=409, detail=f"original path already exists: {original}")
    try:
        os.makedirs(os.path.dirname(original), exist_ok=True)
        os.rename(trash_path, original)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"restore failed: {e}")
    return {"ok": True, "path": original}


@router.post("/dataset/rectified")
async def dataset_rectified(body: dict):
    """Rectify the image at `path` with {K, D, model, ...params, method}.

    `model` selects the rectification family:
      - "fisheye" (default): cv2.fisheye.* with k1..k4 + balance/fov_scale.
      - "pinhole":           cv2.* (non-fisheye) with full Brown-Conrady D + alpha.
    `method` selects the implementation:
      - "remap"     (default): initUndistortRectifyMap + cv2.remap.
      - "undistort":           cv2.fisheye.undistortImage / cv2.undistort.
    Returns JPEG bytes.
    """
    path = body.get("path")
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="not found")
    try:
        K = np.array(body["K"], dtype=np.float64)
        D = np.array(body["D"], dtype=np.float64).reshape(-1, 1)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad K/D: {e}")
    model = (body.get("model") or "fisheye").lower()
    if model not in ("fisheye", "pinhole"):
        raise HTTPException(status_code=400, detail=f"unknown model: {model}")
    method = (body.get("method") or "remap").lower()
    if method not in ("remap", "undistort"):
        raise HTTPException(status_code=400, detail=f"unknown method: {method}")

    img = cv2.imread(path)
    if img is None:
        raise HTTPException(status_code=415, detail="cannot decode image")
    h, w = img.shape[:2]
    if model == "fisheye":
        balance = float(body.get("balance", 0.5))
        fov_scale = float(body.get("fov_scale", 1.0))
        new_K = _new_K("fisheye", K, D, w, h, balance=balance, fov_scale=fov_scale)
    else:
        alpha = float(body.get("alpha", 0.5))
        new_K = _new_K("pinhole", K, D, w, h, alpha=alpha)
    try:
        if method == "undistort":
            if model == "fisheye":
                rect = cv2.fisheye.undistortImage(img, K, D, Knew=new_K, new_size=(w, h))
            else:
                rect = cv2.undistort(img, K, D, None, new_K)
        else:
            if model == "fisheye":
                map1, map2 = cv2.fisheye.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
            else:
                map1, map2 = cv2.initUndistortRectifyMap(
                    K, D, np.eye(3), new_K, (w, h), cv2.CV_16SC2,
                )
            rect = cv2.remap(img, map1, map2, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    except cv2.error as e:
        raise HTTPException(status_code=500, detail=f"rectify failed: {e}")

    ok, buf = cv2.imencode(".jpg", rect, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise HTTPException(status_code=500, detail="encode failed")
    return Response(content=buf.tobytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "no-cache, no-store"})


@router.post("/detect", response_model=DetectResponse)
async def detect(req: DetectRequest) -> DetectResponse:
    return intrinsics.detect_board(req.image_b64, req.board)


@router.post("/detect/file", response_model=DetectResponse)
async def detect_file(req: DetectFileRequest) -> DetectResponse:
    if not os.path.isfile(req.path):
        raise HTTPException(status_code=404, detail="not found")
    return intrinsics.detect_board_file(req.path, req.board)


@router.post("/calibrate/intrinsics", response_model=CalibrationResult)
async def calibrate_intrinsics(req: IntrinsicsRequest) -> CalibrationResult:
    return intrinsics.calibrate(req)


@router.post("/calibrate/fisheye", response_model=CalibrationResult)
async def calibrate_fisheye(req: FisheyeRequest) -> CalibrationResult:
    return fisheye.calibrate(req)


@router.post("/calibrate/extrinsics", response_model=CalibrationResult)
async def calibrate_extrinsics(req: ExtrinsicsRequest) -> CalibrationResult:
    return extrinsics.calibrate(req)


@router.post("/calibrate/handeye", response_model=CalibrationResult)
async def calibrate_handeye(req: HandEyeRequest) -> CalibrationResult:
    return handeye.calibrate(req)


@router.post("/calibrate/chain", response_model=CalibrationResult)
async def calibrate_chain(req: ChainRequest) -> CalibrationResult:
    return chain.calibrate(req)


@router.post("/calibrate/link", response_model=CalibrationResult)
async def calibrate_link(req: LinkRequest) -> CalibrationResult:
    """Inline rigid-link solver. Same math as /calibrate/chain, poses passed as dicts."""
    return chain.calibrate_link(req)


@router.post("/calibration/save")
async def calibration_save(payload: CalibrationSavePayload) -> dict:
    path = yaml_io.save_calibration(payload)
    return {"ok": True, "path": str(path)}


@router.post("/calibration/load", response_model=CalibrationLoadResponse)
async def calibration_load(body: dict) -> CalibrationLoadResponse:
    path = body.get("path")
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="yaml not found")
    return yaml_io.load_calibration(path)


@router.post("/recording/save")
async def recording_save(body: dict) -> dict:
    """Write a canonical pose-list JSON to disk."""
    kind = body.get("kind")
    samples = body.get("samples")
    path = body.get("path")
    if kind not in ("vive", "umi"):
        raise HTTPException(status_code=400, detail=f"unknown kind: {kind}")
    if not isinstance(samples, list) or not samples:
        raise HTTPException(status_code=400, detail="samples must be a non-empty list")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    for i, s in enumerate(samples[:5]):
        if not isinstance(s, dict) or "ts" not in s or "T" not in s:
            raise HTTPException(status_code=400, detail=f"sample[{i}] must have ts and T")
    try:
        ts_list = [float(s["ts"]) for s in samples]
        out = {
            "meta": {
                "kind": kind,
                "n": len(samples),
                "t_first": ts_list[0],
                "t_last": ts_list[-1],
            },
            "samples": samples,
        }
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            json.dump(out, f)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")
    return {"ok": True, "path": path, "n": len(samples)}


@router.post("/recording/import_mcap")
async def recording_import_mcap(body: dict) -> dict:
    """Read an MCAP file and extract foxglove.PoseInFrame messages on the given topic.

    Body: { mcap_path, topic, out_path }
    Writes a canonical pose-list JSON to out_path.
    Returns { ok, count, t_first, t_last, path }.
    """
    mcap_path = body.get("mcap_path")
    topic = body.get("topic")
    out_path = body.get("out_path")
    if not mcap_path or not os.path.isfile(mcap_path):
        raise HTTPException(status_code=404, detail="mcap not found")
    if not topic:
        raise HTTPException(status_code=400, detail="topic is required")
    if not out_path:
        raise HTTPException(status_code=400, detail="out_path is required")

    from mcap.reader import make_reader
    from mcap_protobuf.decoder import DecoderFactory

    samples = []
    n_drop_quat = 0
    n_seen = 0
    try:
        with open(mcap_path, "rb") as f:
            reader = make_reader(f, decoder_factories=[DecoderFactory()])
            iter_decoded = reader.iter_decoded_messages(topics=[topic])
            for _schema, _channel, _msg, pb in iter_decoded:
                n_seen += 1
                ts = pb.timestamp.seconds + pb.timestamp.nanos / 1e9
                qx = pb.pose.orientation.x
                qy = pb.pose.orientation.y
                qz = pb.pose.orientation.z
                qw = pb.pose.orientation.w
                qnorm = (qx * qx + qy * qy + qz * qz + qw * qw) ** 0.5
                if qnorm < 0.5:
                    n_drop_quat += 1
                    continue
                qx, qy, qz, qw = qx / qnorm, qy / qnorm, qz / qnorm, qw / qnorm
                R = np.array([
                    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
                    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
                    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
                ], dtype=np.float64)
                T = np.eye(4)
                T[:3, :3] = R
                T[:3, 3] = [pb.pose.position.x, pb.pose.position.y, pb.pose.position.z]
                samples.append({"ts": ts, "T": T.tolist()})
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"mcap read failed: {e}")

    if n_seen == 0:
        raise HTTPException(status_code=400, detail=f"no messages found on topic {topic!r}")

    if not samples:
        raise HTTPException(status_code=400, detail=f"all {n_seen} messages had degenerate quaternions")

    out = {
        "meta": {
            "kind": "umi",
            "n": len(samples),
            "t_first": samples[0]["ts"],
            "t_last": samples[-1]["ts"],
            "topic": topic,
            "n_dropped_quat": n_drop_quat,
        },
        "samples": samples,
    }
    try:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(out, f)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")

    return {
        "ok": True,
        "count": len(samples),
        "t_first": out["meta"]["t_first"],
        "t_last": out["meta"]["t_last"],
        "path": out_path,
    }


@router.post("/recording/sync")
async def recording_sync(body: dict) -> dict:
    """Sync a Vive recording + UMI import into a paired-sample JSON."""
    from app.calib.sync import sync_streams

    vive_path = body.get("vive_path")
    umi_path = body.get("umi_path")
    out_path = body.get("out_path")
    if not (vive_path and os.path.isfile(vive_path)):
        raise HTTPException(status_code=404, detail="vive_path not found")
    if not (umi_path and os.path.isfile(umi_path)):
        raise HTTPException(status_code=404, detail="umi_path not found")
    if not out_path:
        raise HTTPException(status_code=400, detail="out_path required")

    max_skew_s = float(body.get("max_skew_s", 5.0))
    max_pair_gap_s = float(body.get("max_pair_gap_s", 0.05))

    with open(vive_path) as f:
        vive_data = json.load(f)
    with open(umi_path) as f:
        umi_data = json.load(f)

    res = sync_streams(
        vive_data["samples"], umi_data["samples"],
        max_skew_s=max_skew_s, max_pair_gap_s=max_pair_gap_s,
    )
    if not res["ok"]:
        raise HTTPException(status_code=400, detail=res.get("reason") or "sync failed")
    if res["n_pairs"] < 50:
        raise HTTPException(status_code=400, detail=f"only {res['n_pairs']} pairs after sync (need >= 50)")

    out = {
        "meta": {
            "kind": "synced",
            "n": res["n_pairs"],
            "delta_t": res["delta_t"],
            "vive_rot_deg": res["vive_rot_deg"],
            "umi_rot_deg": res["umi_rot_deg"],
        },
        "samples": res["pairs"],
    }
    try:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(out, f)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")

    return {
        "ok": True,
        "n_pairs": res["n_pairs"],
        "delta_t": res["delta_t"],
        "snr": res.get("snr"),
        "vive_rot_deg": res["vive_rot_deg"],
        "umi_rot_deg": res["umi_rot_deg"],
        "path": out_path,
    }


@router.post("/calibrate/handeye_pose")
async def calibrate_handeye_pose(body: dict) -> CalibrationResult:
    """Solve T_vive_umi from a synced JSON file (Task 5 output).
    Body: { synced_path, method = "daniilidis" }.
    """
    from app.calib.handeye_pose import solve_handeye_pose

    synced_path = body.get("synced_path")
    method = (body.get("method") or "daniilidis").lower()
    if not (synced_path and os.path.isfile(synced_path)):
        raise HTTPException(status_code=404, detail="synced_path not found")
    if method not in ("tsai", "park", "horaud", "andreff", "daniilidis"):
        raise HTTPException(status_code=400, detail=f"unknown method: {method}")

    with open(synced_path) as f:
        data = json.load(f)
    pairs = data.get("samples") or []
    return solve_handeye_pose(pairs, method=method)


@router.get("/recording/list_topics")
async def recording_list_topics(mcap_path: str) -> dict:
    """Peek at the MCAP file and return topics whose schema is foxglove.PoseInFrame."""
    if not mcap_path or not os.path.isfile(mcap_path):
        raise HTTPException(status_code=404, detail="mcap not found")
    from mcap.reader import make_reader
    try:
        with open(mcap_path, "rb") as f:
            reader = make_reader(f)
            summary = reader.get_summary()
            schemas = summary.schemas
            channels = summary.channels
            stats = summary.statistics.channel_message_counts
            pose_schema_ids = {
                s.id for s in schemas.values()
                if s.name == "foxglove.PoseInFrame"
            }
            topics = [
                {
                    "topic": ch.topic,
                    "n": int(stats.get(ch.id, 0)),
                    "schema": schemas[ch.schema_id].name if ch.schema_id in schemas else None,
                }
                for ch in channels.values()
                if ch.schema_id in pose_schema_ids
            ]
            topics.sort(key=lambda t: -t["n"])
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"mcap read failed: {e}")
    return {"topics": topics}


@router.websocket("/stream")
async def stream(ws: WebSocket) -> None:
    """Pushes camera frames + tracker poses. Scaffold: emits a heartbeat tick."""
    await ws.accept()
    try:
        while True:
            await ws.send_text(json.dumps({"t": time.time(), "type": "heartbeat"}))
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        log.info("stream client disconnected")


# ---- pose stream -----------------------------------------------------------
# Multiplexes one or more pluggable `PoseSource`s behind `?sources=a,b,...`.
# Wire format: first message is `hello` with the concatenated device list; then
# `sample` messages carry a merged {device_id: 4x4 pose} dict per tick. Sources
# sample independently, so the merged tick conflates up to ~one period of skew
# between them — acceptable for slow rigid-body calibration.

from app.sources.poses import PoseSource
from app.sources.poses.mock import MockPoseSource


def _build_pose_source(source: str, ip_address: str | None) -> PoseSource:
    s = (source or "mock").lower()
    if s == "mock":
        return MockPoseSource()
    if s == "oculus":
        # Import lazily — pulls in the vendored submodule + adb client only
        # when this source is actually requested.
        from app.sources.poses.oculus import OculusPoseSource
        return OculusPoseSource(ip_address=ip_address)
    if s == "steamvr":
        from app.sources.poses.steamvr import SteamVRPoseSource
        return SteamVRPoseSource()
    raise ValueError(f"unknown pose source: {source!r}")


def _parse_sources(sources: str) -> list[str]:
    names = [s.strip().lower() for s in (sources or "mock").split(",") if s.strip()]
    return names or ["mock"]


@router.websocket("/poses/stream")
async def poses_stream(
    ws: WebSocket,
    fps: int = 30,
    sources: str = "mock",
    ip: str | None = None,
) -> None:
    """Streams merged poses from one or more sources.

    Query params:
      - fps:     tick rate (clamped ≥ 1)
      - sources: comma list, e.g. "mock" or "oculus,steamvr"
      - ip:      optional IP for network ADB (applies to the oculus source)
    """
    await ws.accept()
    names = _parse_sources(sources)
    built: list[tuple[str, PoseSource]] = []
    try:
        for name in names:
            try:
                built.append((name, _build_pose_source(name, ip)))
            except Exception as e:
                log.warning("pose source %r failed to init: %s", name, e)
                await ws.send_text(json.dumps({
                    "type": "error",
                    "source": name,
                    "message": str(e),
                }))
                await ws.close(code=1011)
                return

        # Merge hello envelopes: union of device lists (ordered by source),
        # first non-null gt_T_a_b wins (mock is the only source that sets it),
        # max bases wins (only steamvr sets non-zero).
        all_devices: list[str] = []
        seen: set[str] = set()
        gt_link = None
        bases = 0
        for _name, src in built:
            h = src.hello()
            for d in h.get("devices") or []:
                if d not in seen:
                    seen.add(d)
                    all_devices.append(d)
            if gt_link is None and h.get("gt_T_a_b") is not None:
                gt_link = h["gt_T_a_b"]
            bases = max(bases, int(h.get("bases") or 0))

        await ws.send_text(json.dumps({
            "type": "hello",
            "sources": names,
            "fps": int(fps),
            "devices": all_devices,
            "gt_T_a_b": gt_link,
            "bases": bases,
        }))

        period = 1.0 / max(1, fps)
        seq = 0
        t0 = time.monotonic()
        while True:
            t = time.monotonic() - t0
            merged: dict = {}
            for _name, src in built:
                merged.update(src.poll(t))
            msg = {"type": "sample", "seq": seq, "ts": t, "wall_ts": time.time(), "poses": merged}
            try:
                await ws.send_text(json.dumps(msg))
            except (WebSocketDisconnect, RuntimeError):
                break
            seq += 1
            await asyncio.sleep(period)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("poses/stream failed")
    finally:
        for _name, src in built:
            try: src.close()
            except Exception: log.exception("source close failed")


@router.websocket("/stream/ws")
async def stream_ws(
    ws: WebSocket,
    device: str,
    fps: int = 10,
    quality: int = 70,
    detect: bool = False,
    board_type: str = "chess",
    cols: int = 9,
    rows: int = 6,
    square: float = 0.025,
    marker: float | None = None,
    dictionary: str = "DICT_5X5_100",
) -> None:
    """Live-detect stream. Each binary message frames as:
        [u32 LE json_len] [json meta] [jpeg bytes]
    `meta` carries {seq, ts, image_size:[w,h], corners:[[x,y],...], ids}.
    When `detect=0`, corners is empty and encoding is the only per-frame work.
    """
    await ws.accept()
    src = source_manager.get(device)
    try:
        if not src.wait_frame(timeout=3.0):
            await ws.close(code=1011, reason="no frame from camera")
            return

        board = Board(
            type=board_type, cols=cols, rows=rows,
            square=square, marker=marker, dictionary=dictionary,
        )
        min_interval = 1.0 / max(1, fps)
        last_seq = -1
        last_sent = 0.0

        while True:
            # wait for a fresh frame (sequence-based wakeup keeps latency low)
            while src._latest_seq == last_seq:
                await asyncio.sleep(0.003)
            now = time.time()
            if last_sent and now - last_sent < min_interval:
                await asyncio.sleep(min_interval - (now - last_sent))
            frame = src.read()
            if frame is None:
                continue
            seq = src._latest_seq
            last_seq = seq
            h, w = frame.shape[:2]

            corners: list[list[float]] = []
            ids = None
            if detect:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                res = await asyncio.to_thread(_io.detect_board, gray, board)
                if res is not None:
                    corners_arr, _obj = res
                    corners = corners_arr.tolist()

            ok, buf = await asyncio.to_thread(
                cv2.imencode, ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
            )
            if not ok:
                continue

            meta = {
                "seq": int(seq), "ts": time.time(),
                "image_size": [int(w), int(h)],
                "corners": corners, "ids": ids,
            }
            header = json.dumps(meta).encode("utf-8")
            payload = struct.pack("<I", len(header)) + header + buf.tobytes()
            try:
                await ws.send_bytes(payload)
            except (WebSocketDisconnect, RuntimeError):
                break
            last_sent = time.time()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("stream/ws failed")
    finally:
        source_manager.release(device)
