"""OpenCV VideoCapture wrapper with a background grabber thread.

A single thread continuously reads from the device and stores the latest frame in a slot.
Clients call `.read()` to pull whatever is most recent — no queueing, no backpressure, latest-wins.
This decouples capture cadence from consumer cadence so slow clients don't stall the device."""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger("calib.source")

_DEV_RE = re.compile(r"/dev/video(\d+)$")


def _device_id(device: str) -> int | str:
    m = _DEV_RE.match(device)
    return int(m.group(1)) if m else device


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
        while not self._stop.is_set():
            ok, frame = self.cap.read()
            if ok:
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
        return {
            "device": self.device,
            "open": True,
            "width": int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "fps_advertised": float(self.cap.get(cv2.CAP_PROP_FPS) or 0),
            "capture_fps": round(self.capture_fps(), 2),
            "latest_seq": self._latest_seq,
        }
