"""Unit tests for PoseSource.hello() envelopes — verifies the `bases` field
that the Topbar's SteamVR pill depends on is always present."""
from __future__ import annotations

from app.sources.poses.mock import MockPoseSource


def test_mock_hello_includes_bases_zero():
    src = MockPoseSource()
    h = src.hello()
    assert h["bases"] == 0
    assert "devices" in h
