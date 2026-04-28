"""GET /stream/ros2_topics — happy path returns discovered topics; rclpy-missing
returns 503 with a clear hint."""
from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


def test_ros2_topics_happy_path():
    fake = [
        {"topic": "/camera/image_raw/compressed", "n_publishers": 1},
        {"topic": "/cam0/compressed", "n_publishers": 2},
    ]
    with patch(
        "app.sources.ros2_context.list_compressed_image_topics",
        return_value=fake,
    ):
        client = TestClient(app)
        r = client.get("/stream/ros2_topics")
    assert r.status_code == 200
    body = r.json()
    assert body["topics"] == fake


def test_ros2_topics_503_when_rclpy_missing():
    """A clear, actionable error message rather than an opaque 500."""
    with patch(
        "app.sources.ros2_context.list_compressed_image_topics",
        side_effect=RuntimeError(
            "rclpy unavailable — source ROS2 setup before launching backend"
        ),
    ):
        client = TestClient(app)
        r = client.get("/stream/ros2_topics")
    assert r.status_code == 503
    assert "rclpy unavailable" in r.json()["detail"]
