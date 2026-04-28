"""End-to-end test for Ros2ImageSource: publish a JPEG-encoded CompressedImage
into a real rclpy graph, assert the source decodes it. Skipped automatically
when rclpy/cv_bridge aren't installed."""
from __future__ import annotations

import time

import cv2
import numpy as np
import pytest

rclpy = pytest.importorskip("rclpy")
pytest.importorskip("cv_bridge")
pytest.importorskip("sensor_msgs.msg")

from sensor_msgs.msg import CompressedImage  # noqa: E402

from app.sources import ros2_context  # noqa: E402
from app.sources.ros2 import Ros2ImageSource  # noqa: E402


@pytest.fixture
def ros2_node():
    node = ros2_context.ensure_started()
    yield node
    ros2_context.shutdown()


def test_compressed_image_round_trip(ros2_node):
    topic = "/test/calib/compressed"
    src = Ros2ImageSource(topic)
    src.start()
    try:
        # Build a publisher inside the same node so we don't need a second context.
        pub = ros2_node.create_publisher(CompressedImage, topic, 10)
        rgb = np.full((48, 64, 3), (10, 200, 30), dtype=np.uint8)
        ok, jpg = cv2.imencode(".jpg", rgb)
        assert ok
        msg = CompressedImage()
        msg.format = "jpeg"
        msg.data = jpg.tobytes()
        # Push a handful of messages — sensor QoS is best-effort, occasional drops are fine.
        deadline = time.time() + 3.0
        while time.time() < deadline:
            pub.publish(msg)
            if src.wait_frame(timeout=0.2):
                break
        frame = src.read()
        assert frame is not None
        assert frame.shape == (48, 64, 3)
        info = src.info()
        assert info["open"] is True
        assert info["width"] == 64 and info["height"] == 48
    finally:
        src.stop()
