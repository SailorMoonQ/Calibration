"""sensor_msgs/CompressedImage subscriber that conforms to the CameraSource interface.

Exposes the same duck-typed surface (start, stop, read, wait_frame, info,
capture_fps, _latest_seq, _refs) so app.api.routes can treat ROS2 topics
and /dev/video* devices identically through source_manager.get().
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Optional

import numpy as np

from app.sources import ros2_context

log = logging.getLogger("calib.source.ros2")


class Ros2ImageSource:
    def __init__(self, topic: str) -> None:
        self.topic = topic
        self._latest: Optional[np.ndarray] = None
        self._latest_ts: float = 0.0
        self._latest_seq: int = 0
        self._lock = threading.Lock()
        self._refs = 0
        self._sub = None
        self._bridge = None
        self._size: tuple[int, int] | None = None  # (w, h)
        self._ticks: deque[float] = deque(maxlen=90)
        self._decode_warned = False

    def start(self) -> None:
        with self._lock:
            self._refs += 1
            if self._sub is not None:
                return
            node = ros2_context.ensure_started()
            from cv_bridge import CvBridge
            from rclpy.qos import qos_profile_sensor_data
            from sensor_msgs.msg import CompressedImage
            self._bridge = CvBridge()
            self._sub = node.create_subscription(
                CompressedImage, self.topic, self._on_msg, qos_profile_sensor_data
            )
            log.info("ros2 subscribed · %s", self.topic)

    def _on_msg(self, msg) -> None:
        try:
            frame = self._bridge.compressed_imgmsg_to_cv2(msg, "bgr8")
        except Exception as e:
            if not self._decode_warned:
                log.warning("ros2 decode failed on %s: %s", self.topic, e)
                self._decode_warned = True
            return
        if frame is None:
            return
        h, w = frame.shape[:2]
        now = time.time()
        with self._lock:
            self._latest = frame
            self._latest_ts = now
            self._latest_seq += 1
            self._size = (w, h)
            self._ticks.append(now)

    def stop(self) -> None:
        with self._lock:
            self._refs = max(0, self._refs - 1)
            if self._refs > 0 or self._sub is None:
                return
            node = ros2_context.get_node()
            if node is not None:
                try:
                    node.destroy_subscription(self._sub)
                except Exception as e:  # pragma: no cover
                    log.debug("destroy_subscription failed: %s", e)
            self._sub = None
            self._bridge = None
            self._latest = None
            log.info("ros2 unsubscribed · %s", self.topic)

    def read(self) -> Optional[np.ndarray]:
        with self._lock:
            return None if self._latest is None else self._latest.copy()

    def wait_frame(self, timeout: float = 2.0) -> bool:
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self._lock:
                if self._latest is not None:
                    return True
            time.sleep(0.02)
        return False

    def capture_fps(self) -> float:
        cutoff = time.time() - 2.0
        with self._lock:
            recent = [t for t in self._ticks if t >= cutoff]
        if len(recent) < 2:
            return 0.0
        span = recent[-1] - recent[0]
        return (len(recent) - 1) / span if span > 0 else 0.0

    def info(self) -> dict:
        with self._lock:
            sub_open = self._sub is not None
            size = self._size
        if not sub_open:
            return {"device": f"ros2:{self.topic}", "open": False}
        if size is None:
            return {
                "device": f"ros2:{self.topic}",
                "open": True,
                "width": 0, "height": 0,
                "raw_width": 0, "raw_height": 0,
                "clipped": False,
                "fps_advertised": 0.0,
                "capture_fps": 0.0,
                "latest_seq": self._latest_seq,
            }
        w, h = size
        return {
            "device": f"ros2:{self.topic}",
            "open": True,
            "width": w, "height": h,
            "raw_width": w, "raw_height": h,
            "clipped": False,
            "fps_advertised": 0.0,
            "capture_fps": round(self.capture_fps(), 2),
            "latest_seq": self._latest_seq,
        }
