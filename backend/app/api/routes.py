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


@router.post("/dataset/rectified")
async def dataset_rectified(body: dict):
    """Fisheye-rectify the image at `path` with {K, D, balance, fov_scale}. Returns JPEG bytes."""
    path = body.get("path")
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="not found")
    try:
        K = np.array(body["K"], dtype=np.float64)
        D = np.array(body["D"], dtype=np.float64).reshape(-1, 1)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad K/D: {e}")
    balance = float(body.get("balance", 0.5))
    fov_scale = float(body.get("fov_scale", 1.0))

    img = cv2.imread(path)
    if img is None:
        raise HTTPException(status_code=415, detail="cannot decode image")
    h, w = img.shape[:2]
    try:
        new_K = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(
            K, D, (w, h), np.eye(3), balance=balance, fov_scale=fov_scale,
        )
        map1, map2 = cv2.fisheye.initUndistortRectifyMap(
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
# Pluggable source behind `?source=mock|oculus`. The wire format is stable:
# first message is `hello` (devices, fps, optional ground-truth link), then
# `sample` messages carrying {device_id: 4x4 pose} at the requested rate.

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


@router.websocket("/poses/stream")
async def poses_stream(
    ws: WebSocket,
    fps: int = 30,
    source: str = "mock",
    ip: str | None = None,
) -> None:
    """Streams paired poses for the Link tab from the selected source.

    Query params:
      - fps:    tick rate (clamped ≥ 1)
      - source: "mock" (default) | "oculus"
      - ip:     optional IP for network ADB when source=oculus
    """
    await ws.accept()
    try:
        try:
            src: PoseSource = _build_pose_source(source, ip)
        except Exception as e:
            log.warning("pose source %r failed to init: %s", source, e)
            await ws.send_text(json.dumps({
                "type": "error",
                "source": source,
                "message": str(e),
            }))
            await ws.close(code=1011)
            return

        hello = src.hello()
        await ws.send_text(json.dumps({
            "type": "hello",
            "source": source,
            "fps": int(fps),
            "devices": hello.get("devices", []),
            "gt_T_a_b": hello.get("gt_T_a_b"),
        }))

        period = 1.0 / max(1, fps)
        seq = 0
        t0 = time.monotonic()
        try:
            while True:
                t = time.monotonic() - t0
                poses = src.poll(t)
                msg = {
                    "type": "sample",
                    "seq": seq, "ts": t,
                    "poses": poses,
                }
                try:
                    await ws.send_text(json.dumps(msg))
                except (WebSocketDisconnect, RuntimeError):
                    break
                seq += 1
                await asyncio.sleep(period)
        finally:
            src.close()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("poses/stream failed")


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
