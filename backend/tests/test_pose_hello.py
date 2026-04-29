"""Unit tests for PoseSource.hello() envelopes — verifies the `bases` field
that the Topbar's SteamVR pill depends on is always present."""
from __future__ import annotations

from app.sources.poses.mock import MockPoseSource


def test_mock_hello_includes_bases_zero():
    src = MockPoseSource()
    h = src.hello()
    assert h["bases"] == 0
    assert "devices" in h


import sys
import types

import pytest


class _FakeOpenVR:
    """Stand-in for the triad-openvr module so steamvr.py can be tested
    without a real SteamVR runtime. Mirrors the small surface that
    SteamVRPoseSource.__init__ touches: a `triad_openvr` callable that
    returns an object with a `.devices` dict mapping name -> device stub."""

    def __init__(self, device_names):
        self._device_names = device_names

    def triad_openvr(self):
        ns = types.SimpleNamespace()
        ns.devices = {name: object() for name in self._device_names}
        return ns


@pytest.fixture
def fake_triad(monkeypatch):
    """Install a fake `triad_openvr` module into sys.modules with the
    requested device list. Yields the install function; tests call it
    with the names they want."""
    def _install(names):
        fake = _FakeOpenVR(names)
        monkeypatch.setitem(sys.modules, "triad_openvr", fake)
        return fake
    return _install


def test_steamvr_hello_counts_tracking_references(fake_triad):
    fake_triad([
        "tracking_reference_1", "tracking_reference_2",
        "tracker_1", "controller_1",
    ])
    from app.sources.poses.steamvr import SteamVRPoseSource
    src = SteamVRPoseSource()
    h = src.hello()
    assert h["bases"] == 2
    assert "tracking_reference_1" not in h["devices"]
    assert "tracker_1" in h["devices"]


def test_steamvr_hello_zero_bases(fake_triad):
    fake_triad(["tracker_1"])
    from app.sources.poses.steamvr import SteamVRPoseSource
    src = SteamVRPoseSource()
    h = src.hello()
    assert h["bases"] == 0


def test_poses_stream_uses_pose_manager(monkeypatch):
    """The /poses/stream handler must acquire/release through pose_manager so
    a second concurrent client doesn't double-open the underlying source."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.sources.poses import manager as pose_manager

    class FakePose:
        def __init__(self, **kw): self.closed = False
        def hello(self): return {"devices": ["d"]}
        def poll(self, t): return {"d": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]}
        def close(self): self.closed = True

    monkeypatch.setattr(pose_manager, "_sources", {})
    monkeypatch.setattr(pose_manager, "_refs", {})
    monkeypatch.setattr(pose_manager, "_BUILDERS", {"mock": lambda **kw: FakePose()})

    client = TestClient(app)
    with client.websocket_connect("/poses/stream?sources=mock&fps=30") as ws1:
        hello = ws1.receive_json()
        assert hello["type"] == "hello"
        assert pose_manager._refs.get("mock") == 1
        with client.websocket_connect("/poses/stream?sources=mock&fps=30") as ws2:
            ws2.receive_json()  # discard hello
            assert pose_manager._refs.get("mock") == 2
        # ws2 closed — ref drops to 1, source still alive.
        # Give the server a beat to run its finally block.
        import time as _t
        for _ in range(50):
            if pose_manager._refs.get("mock") == 1:
                break
            _t.sleep(0.02)
        assert pose_manager._refs.get("mock") == 1
    # Both closed — manager evicts. Same brief poll for the cleanup.
    import time as _t
    for _ in range(50):
        if "mock" not in pose_manager._refs:
            break
        _t.sleep(0.02)
    assert "mock" not in pose_manager._refs
