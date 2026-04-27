"""OpenCV VideoCapture wrapper with a background grabber thread.

A single thread continuously reads from the device and stores the latest frame in a slot.
Clients call `.read()` to pull whatever is most recent — no queueing, no backpressure, latest-wins.
This decouples capture cadence from consumer cadence so slow clients don't stall the device."""
from __future__ import annotations

import logging
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger("calib.source")

_DEV_RE = re.compile(r"/dev/video(\d+)$")

# Anything wider OR taller than this gets clipped (center-crop to square + resize) so
# the rest of the pipeline doesn't need to deal with 1080p+ frames. The threshold and
# target stay constants for now — easy to lift to a per-camera config later.
_CLIP_THRESHOLD = (720, 720)    # (max_width, max_height) — exceed either dim → clip
_CLIP_TARGET = (720, 720)       # (out_width, out_height) after center-crop


def _maybe_clip(frame: np.ndarray) -> np.ndarray:
    """Center-crop to a square then resize to _CLIP_TARGET when the frame exceeds the
    threshold. Returns the original frame untouched when below threshold so cameras
    already at sensible sizes (e.g. 640×480) pay no cost."""
    if frame is None:
        return frame
    h, w = frame.shape[:2]
    if w <= _CLIP_THRESHOLD[0] and h <= _CLIP_THRESHOLD[1]:
        return frame
    side = min(w, h)
    x0 = (w - side) // 2
    y0 = (h - side) // 2
    crop = frame[y0:y0 + side, x0:x0 + side]
    if (side, side) == _CLIP_TARGET:
        return crop
    return cv2.resize(crop, _CLIP_TARGET, interpolation=cv2.INTER_AREA)


def _device_id(device: str) -> int | str:
    m = _DEV_RE.match(device)
    return int(m.group(1)) if m else device


def _force_auto_exposure(device: str) -> None:
    """Some UVC cameras (notably the IMX307-based ones) latch auto_exposure=manual
    with a tiny exposure_time_absolute, which yields all-black frames. The V4L2 driver
    only accepts the change *before* streaming starts, so we set it via v4l2-ctl
    before cv2.VideoCapture opens the device.

    Best-effort: missing v4l2-ctl, non-/dev/video paths, and ioctl failures are ignored —
    on platforms where this isn't applicable the camera still opens normally."""
    if not _DEV_RE.match(device):
        return
    bin_ = shutil.which("v4l2-ctl")
    if not bin_:
        return
    try:
        # auto_exposure menu: 1 = Manual, 3 = Aperture Priority (auto). Cameras that don't
        # support menu value 3 reject the call — that's harmless, we move on.
        subprocess.run(
            [bin_, "-d", device, "-c", "auto_exposure=3"],
            check=False, capture_output=True, timeout=2.0,
        )
    except Exception as e:  # pragma: no cover — tolerant of missing tooling
        log.debug("v4l2-ctl auto_exposure setup skipped for %s: %s", device, e)


class CameraSource:
    def __init__(self, device: str) -> None:
        self.device = device
        self.cap: cv2.VideoCapture | None = None
        self._latest: np.ndarray | None = None
        self._latest_ts: float = 0.0
        self._latest_seq: int = 0
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._refs = 0
        self._lock = threading.Lock()
        self._ticks: deque[float] = deque(maxlen=90)  # ~3s window at 30fps

    def start(self) -> None:
        with self._lock:
            self._refs += 1
            if self.cap is not None:
                return
            # Pre-open: switch off any latched manual-exposure / dim-frame state. Must run
            # before VideoCapture acquires the device or the driver may ignore the change.
            _force_auto_exposure(self.device)
            cap = cv2.VideoCapture(_device_id(self.device))
            if not cap.isOpened():
                self._refs -= 1
                raise RuntimeError(f"cannot open {self.device}")
            # UVC webcams usually expose both YUYV and MJPG; YUYV eats far more USB
            # bandwidth, which can cap effective fps even when the driver advertises 60.
            # Requesting MJPG typically unlocks the full rate. Leave BUFFERSIZE at the
            # driver default — setting it to 1 forces driver/consumer ping-pong over a
            # single V4L2 buffer and halves throughput (observed: ~37 fps vs 60). Our
            # grabber thread keeps the ring drained into `_latest`, so a larger ring
            # doesn't increase latency.
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FPS, 60)
            self.cap = cap
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name=f"grab-{self.device}", daemon=True)
            self._thread.start()
            log.info("opened camera %s · %d fps", self.device, int(cap.get(cv2.CAP_PROP_FPS)))

    def _run(self) -> None:
        misses = 0
        logged_clip = False
        while not self._stop.is_set():
            ok, frame = self.cap.read()
            if ok:
                if frame is not None:
                    h0, w0 = frame.shape[:2]
                    frame = _maybe_clip(frame)
                    if not logged_clip and (w0, h0) != frame.shape[1::-1]:
                        log.info("%s: clipping %dx%d → %dx%d", self.device, w0, h0, frame.shape[1], frame.shape[0])
                        logged_clip = True
                now = time.time()
                self._latest = frame
                self._latest_ts = now
                self._latest_seq += 1
                self._ticks.append(now)
                misses = 0
            else:
                misses += 1
                if misses > 50:
                    log.warning("%s: 50 failed reads in a row", self.device)
                    misses = 0
                time.sleep(0.02)

    def stop(self) -> None:
        with self._lock:
            self._refs = max(0, self._refs - 1)
            if self._refs > 0 or self.cap is None:
                return
            self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        if self.cap:
            self.cap.release()
        self.cap = None
        self._latest = None
        log.info("closed camera %s", self.device)

    def read(self) -> Optional[np.ndarray]:
        frm = self._latest
        return None if frm is None else frm.copy()

    def wait_frame(self, timeout: float = 2.0) -> bool:
        t0 = time.time()
        while self._latest is None and time.time() - t0 < timeout and not self._stop.is_set():
            time.sleep(0.02)
        return self._latest is not None

    def capture_fps(self) -> float:
        # Rolling FPS over the last ~3 s of grabs; ignore ticks older than 2 s so the
        # readout decays quickly when the camera stalls.
        cutoff = time.time() - 2.0
        recent = [t for t in self._ticks if t >= cutoff]
        if len(recent) < 2:
            return 0.0
        span = recent[-1] - recent[0]
        return (len(recent) - 1) / span if span > 0 else 0.0

    def info(self) -> dict:
        if not self.cap:
            return {"device": self.device, "open": False}
        raw_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        raw_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        # Effective size = what consumers see, post-clip. Falls back to the raw V4L2
        # values until the first frame lands in `_latest`.
        if self._latest is not None:
            eff_h, eff_w = self._latest.shape[:2]
        else:
            eff_w, eff_h = raw_w, raw_h
        clipped = (eff_w, eff_h) != (raw_w, raw_h)
        return {
            "device": self.device,
            "open": True,
            "width": eff_w,
            "height": eff_h,
            "raw_width": raw_w,
            "raw_height": raw_h,
            "clipped": clipped,
            "fps_advertised": float(self.cap.get(cv2.CAP_PROP_FPS) or 0),
            "capture_fps": round(self.capture_fps(), 2),
            "latest_seq": self._latest_seq,
        }
