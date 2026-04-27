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
