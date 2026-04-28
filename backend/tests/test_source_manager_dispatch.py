"""manager.get(key) dispatches CameraSource for /dev/video* and Ros2ImageSource
for ros2:<topic>; both are refcounted across repeat get() calls."""
from __future__ import annotations

from unittest.mock import patch

from app.sources import manager


def test_get_video_path_returns_camera_source(monkeypatch):
    """Plain device paths still go to CameraSource (default branch unchanged)."""
    instances = []

    class FakeCamera:
        def __init__(self, device): instances.append(device); self._refs = 0
        def start(self): self._refs += 1
        def stop(self): self._refs -= 1

    monkeypatch.setattr(manager, "CameraSource", FakeCamera)
    monkeypatch.setattr(manager, "_sources", {})

    src = manager.get("/dev/video0")
    assert isinstance(src, FakeCamera)
    assert instances == ["/dev/video0"]
    assert src._refs == 1
    src2 = manager.get("/dev/video0")
    assert src is src2
    assert src._refs == 2


def test_get_ros2_prefix_returns_ros2_source(monkeypatch):
    """ros2:<topic> instantiates Ros2ImageSource with the topic stripped of the
    ros2: prefix, refcounted same as CameraSource."""
    instances = []

    class FakeRos2:
        def __init__(self, topic): instances.append(topic); self._refs = 0
        def start(self): self._refs += 1
        def stop(self): self._refs -= 1

    monkeypatch.setattr(manager, "_sources", {})
    with patch("app.sources.ros2.Ros2ImageSource", FakeRos2):
        src = manager.get("ros2:/camera/image_raw/compressed")
        assert isinstance(src, FakeRos2)
        assert instances == ["/camera/image_raw/compressed"]
        assert src._refs == 1
        src2 = manager.get("ros2:/camera/image_raw/compressed")
        assert src is src2
        assert src._refs == 2


def test_release_decrements_refcount(monkeypatch):
    """release() pairs with get() — the refcount must come back down."""
    class FakeCamera:
        def __init__(self, device): self._refs = 0
        def start(self): self._refs += 1
        def stop(self): self._refs -= 1

    monkeypatch.setattr(manager, "CameraSource", FakeCamera)
    monkeypatch.setattr(manager, "_sources", {})

    src = manager.get("/dev/video0")
    manager.get("/dev/video0")
    assert src._refs == 2
    manager.release("/dev/video0")
    assert src._refs == 1
    manager.release("/dev/video0")
    assert src._refs == 0
