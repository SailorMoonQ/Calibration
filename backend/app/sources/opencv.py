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

import cv2
import numpy as np

from . import control_store, roi_store, v4l2_controls

log = logging.getLogger("calib.source")

_DEV_RE = re.compile(r"/dev/video(\d+)$")
_V4L2_SIZE_RE = re.compile(r"Size:\s*Discrete\s+(\d+)x(\d+)")

# Default post-grab clip. Set on each new CameraSource so the pipeline never sees
# 1080p+ frames unless the user explicitly raises it via set_clip(). Picked to match
# the historical hard-coded behavior; per-instance now so the renderer can override.
_DEFAULT_CLIP: tuple[int, int] = (720, 720)


def _device_id(device: str) -> int | str:
    m = _DEV_RE.match(device)
    return int(m.group(1)) if m else device


def list_resolutions(device: str) -> list[tuple[int, int]]:
    """Enumerate (width, height) modes the device advertises via v4l2-ctl. Pulls
    every Discrete size across all formats (MJPG/YUYV/etc.) and dedupes — fps mode
    selection still happens in the driver via cap.set(CAP_PROP_FPS). Returns [] when
    v4l2-ctl is unavailable or the device path isn't a /dev/video* node, so the
    caller can fall back to free-text entry without special-casing the missing tool."""
    if not _DEV_RE.match(device):
        return []
    bin_ = shutil.which("v4l2-ctl")
    if not bin_:
        return []
    try:
        out = subprocess.run(
            [bin_, "-d", device, "--list-formats-ext"],
            check=False, capture_output=True, timeout=2.0, text=True,
        )
    except Exception as e:  # pragma: no cover — tolerant of missing tooling
        log.debug("v4l2-ctl listing failed for %s: %s", device, e)
        return []
    sizes: set[tuple[int, int]] = set()
    for line in out.stdout.splitlines():
        m = _V4L2_SIZE_RE.search(line)
        if m:
            sizes.add((int(m.group(1)), int(m.group(2))))
    # Sort ascending by area, then by width — gives a natural small-to-large dropdown.
    return sorted(sizes, key=lambda wh: (wh[0] * wh[1], wh[0]))


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
        self._target_size: tuple[int, int] | None = None
        # Per-source post-grab clip; None disables. Default keeps the historical
        # 720×720 ceiling so existing behavior is unchanged when the renderer
        # never touches set_clip().
        self._clip_target: tuple[int, int] | None = _DEFAULT_CLIP
        # Offset-capable ROI applied AFTER _maybe_clip. Separate from the clip
        # because the clip is a centred downscale (it changes fx/fy) while an ROI
        # is a pure translation (it moves only cx/cy) — mixing the two into one
        # knob would make the resulting intrinsics impossible to reason about.
        self._roi: tuple[int, int, int, int] | None = None

    def _saved_controls(self) -> dict[str, int] | None:
        """The user's active control preset for this camera, or None when they
        have never configured one. Keyed by USB serial so the preset survives the
        device being re-enumerated as a different /dev/videoN."""
        try:
            serial = v4l2_controls.device_serial(self.device)
            key, _ = control_store.device_key(self.device, serial)
            return control_store.active_controls(key)
        except Exception as e:  # never let a config problem block the camera
            log.warning("%s: reading saved controls failed: %s", self.device, e)
            return None

    def _restore_roi(self) -> None:
        try:
            serial = v4l2_controls.device_serial(self.device)
            key, _ = control_store.device_key(self.device, serial)
            roi = roi_store.get_roi(key)
        except Exception as e:
            log.warning("%s: reading saved roi failed: %s", self.device, e)
            return
        if roi:
            self.set_roi(roi["left"], roi["top"], roi["width"], roi["height"])

    def _open_cap(self) -> cv2.VideoCapture:
        """Pre-open setup + cv2.VideoCapture creation. Pre-flight clears any latched
        manual-exposure state, picks MJPG, and applies _target_size when the user has
        explicitly requested a resolution. Must run before any concurrent read."""
        # Replay the user's saved camera controls when they have chosen a preset;
        # otherwise fall back to switching off any latched manual-exposure /
        # dim-frame state. Both must run before VideoCapture acquires the device
        # or the driver may ignore the change.
        #
        # The fallback is the historical behaviour and still guards the all-black
        # frames some IMX307 modules latch into. It is skipped only when the user
        # has explicitly configured controls — silently overwriting a deliberate
        # manual exposure on every stream restart (resolution change, tab switch,
        # backend reconnect) is worse than the risk it protects against, because
        # it fails invisibly: the picture just changes brightness.
        # Replay the saved ROI too — like the controls, it is a property of the
        # camera rather than of this session, and a crop silently disappearing on
        # a resolution change would invalidate whatever was calibrated with it.
        self._restore_roi()
        saved = self._saved_controls()
        if saved:
            v4l2_controls.apply_controls(self.device, saved)
        else:
            _force_auto_exposure(self.device)
        cap = cv2.VideoCapture(_device_id(self.device))
        if not cap.isOpened():
            raise RuntimeError(f"cannot open {self.device}")
        # UVC webcams usually expose both YUYV and MJPG; YUYV eats far more USB
        # bandwidth, which can cap effective fps even when the driver advertises 60.
        # Requesting MJPG typically unlocks the full rate. Leave BUFFERSIZE at the
        # driver default — setting it to 1 forces driver/consumer ping-pong over a
        # single V4L2 buffer and halves throughput (observed: ~37 fps vs 60). Our
        # grabber thread keeps the ring drained into `_latest`, so a larger ring
        # doesn't increase latency.
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        if self._target_size is not None:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._target_size[0])
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._target_size[1])
        cap.set(cv2.CAP_PROP_FPS, 60)
        return cap

    def start(self) -> None:
        with self._lock:
            self._refs += 1
            if self.cap is not None:
                return
            try:
                self.cap = self._open_cap()
            except RuntimeError:
                self._refs -= 1
                raise
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name=f"grab-{self.device}", daemon=True)
            self._thread.start()
            log.info("opened camera %s · %d fps", self.device, int(self.cap.get(cv2.CAP_PROP_FPS)))

    def set_resolution(self, width: int, height: int) -> None:
        """Restart the underlying capture at the requested width/height. Refs stay
        intact — in-flight MJPEG consumers keep their handles and start receiving
        frames at the new resolution as soon as the grabber thread comes back. No-op
        when the camera is already producing frames at the requested size, so polling
        callers don't bounce the stream needlessly.

        The grabber doesn't take self._lock, so we can hold it through thread.join
        and serialize against concurrent start()/stop() calls without deadlock."""
        new_size = (int(width), int(height))
        if new_size[0] <= 0 or new_size[1] <= 0:
            raise ValueError(f"invalid resolution {new_size}")
        with self._lock:
            if self.cap is not None and self._target_size == new_size:
                cur_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                cur_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                if (cur_w, cur_h) == new_size:
                    return
            self._target_size = new_size
            if self.cap is None:
                # No consumers right now; the next start() picks up _target_size.
                return
            self._stop.set()
            thread = self._thread
            if thread is not None:
                thread.join(timeout=1.0)
            self.cap.release()
            self.cap = self._open_cap()
            self._latest = None
            self._ticks.clear()
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name=f"grab-{self.device}", daemon=True)
            self._thread.start()
            log.info("restarted camera %s @ %dx%d", self.device, new_size[0], new_size[1])

    def _maybe_clip(self, frame: np.ndarray) -> np.ndarray:
        """Center-crop to the target's aspect ratio and resize when the frame exceeds
        _clip_target on either axis. None target → pass-through. Aspect-aware crop
        means non-square targets (e.g. 1280×720) keep their proportions instead of
        getting a stretched square crop."""
        target = self._clip_target
        if frame is None or target is None:
            return frame
        tw, th = target
        h, w = frame.shape[:2]
        if w <= tw and h <= th:
            return frame
        target_aspect = tw / th
        src_aspect = w / h
        if src_aspect > target_aspect:
            crop_w = max(1, int(round(h * target_aspect)))
            x0 = (w - crop_w) // 2
            crop = frame[:, x0:x0 + crop_w]
        else:
            crop_h = max(1, int(round(w / target_aspect)))
            y0 = (h - crop_h) // 2
            crop = frame[y0:y0 + crop_h, :]
        if crop.shape[:2] == (th, tw):
            return crop
        return cv2.resize(crop, (tw, th), interpolation=cv2.INTER_AREA)

    def _maybe_roi(self, frame: np.ndarray) -> np.ndarray:
        """Crop to the stored ROI. Pure slice, no resize — a resize would change
        the focal lengths and defeat the point, which is to move the principal
        point without touching anything else.

        Runs after _maybe_clip so the ROI is expressed in the coordinates the
        consumers already see; that way a (cx, cy) measured by calibrating today
        can be fed straight back in without any conversion."""
        roi = self._roi
        if frame is None or roi is None:
            return frame
        h, w = frame.shape[:2]
        left, top, rw, rh = roi
        # Clamp instead of raising: a stale ROI (saved at a higher resolution, or
        # applied before the stream reported its size) must degrade to a smaller
        # crop, not kill the stream.
        left = max(0, min(left, w - 1))
        top = max(0, min(top, h - 1))
        rw = max(1, min(rw, w - left))
        rh = max(1, min(rh, h - top))
        if left == 0 and top == 0 and rw == w and rh == h:
            return frame
        return frame[top:top + rh, left:left + rw]

    def set_roi(self, left, top, width, height) -> None:
        """Set or clear the ROI. Falsy width/height clears it. No camera restart —
        cropping happens after every read, so the next frame already reflects it."""
        if not width or not height or int(width) <= 0 or int(height) <= 0:
            with self._lock:
                self._roi = None
                self._ticks.clear()
            log.info("disabled roi on %s", self.device)
            return
        with self._lock:
            self._roi = (max(0, int(left)), max(0, int(top)), int(width), int(height))
            self._ticks.clear()
        log.info("roi on %s set to %dx%d+%d+%d", self.device, int(width), int(height),
                 int(left), int(top))

    def get_roi(self) -> dict | None:
        roi = self._roi
        if roi is None:
            return None
        return {"left": roi[0], "top": roi[1], "width": roi[2], "height": roi[3]}

    def _run(self) -> None:
        misses = 0
        logged_clip = False
        while not self._stop.is_set():
            ok, frame = self.cap.read()
            if ok:
                if frame is not None:
                    h0, w0 = frame.shape[:2]
                    frame = self._maybe_clip(frame)
                    frame = self._maybe_roi(frame)
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

    def set_clip(self, width: int | None, height: int | None) -> None:
        """Update the post-grab clip target. Pass (0, 0) or (None, None) to disable.
        No camera restart — clipping happens after every cap.read(), so the next
        frame already reflects the change. Reset _ticks so the measured fps doesn't
        carry stale samples across the change in pipeline cost."""
        if not width or not height or width <= 0 or height <= 0:
            with self._lock:
                self._clip_target = None
                self._ticks.clear()
            log.info("disabled clip on %s", self.device)
            return
        with self._lock:
            self._clip_target = (int(width), int(height))
            self._ticks.clear()
        log.info("clip on %s set to %dx%d", self.device, int(width), int(height))

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

    def read(self) -> np.ndarray | None:
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
        # values until the first frame lands in `_latest`. Snapshot the slot first —
        # stop()/set_resolution() can null it between the check and the shape read.
        frm = self._latest
        if frm is not None:
            eff_h, eff_w = frm.shape[:2]
        else:
            eff_w, eff_h = raw_w, raw_h
        clipped = (eff_w, eff_h) != (raw_w, raw_h)
        clip = self._clip_target
        return {
            "device": self.device,
            "open": True,
            "width": eff_w,
            "height": eff_h,
            "raw_width": raw_w,
            "raw_height": raw_h,
            "clipped": clipped,
            "clip_width": clip[0] if clip else None,
            "clip_height": clip[1] if clip else None,
            "fps_advertised": float(self.cap.get(cv2.CAP_PROP_FPS) or 0),
            "capture_fps": round(self.capture_fps(), 2),
            "latest_seq": self._latest_seq,
        }
