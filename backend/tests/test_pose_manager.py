"""pose_manager ref-counts PoseSource instances keyed by source name; multiple
get() calls share one underlying client and only the final release() closes it."""
from __future__ import annotations

import pytest

from app.sources.poses import manager as pose_manager


class FakePose:
    instances: list = []

    def __init__(self, **kw):
        self.kw = kw
        self.closed = False
        FakePose.instances.append(self)

    def hello(self): return {"devices": ["d0"]}
    def poll(self, t): return {"d0": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]}
    def close(self): self.closed = True


def _patch_builders(monkeypatch):
    FakePose.instances = []
    monkeypatch.setattr(pose_manager, "_BUILDERS", {"mock": lambda **kw: FakePose(**kw)})
    monkeypatch.setattr(pose_manager, "_sources", {})
    monkeypatch.setattr(pose_manager, "_refs", {})


def test_get_creates_source_first_time(monkeypatch):
    _patch_builders(monkeypatch)
    src = pose_manager.get("mock")
    assert isinstance(src, FakePose)
    assert pose_manager._refs["mock"] == 1
    assert len(FakePose.instances) == 1


def test_get_shares_instance_across_callers(monkeypatch):
    _patch_builders(monkeypatch)
    a = pose_manager.get("mock")
    b = pose_manager.get("mock")
    assert a is b
    assert pose_manager._refs["mock"] == 2
    assert len(FakePose.instances) == 1


def test_release_closes_only_at_zero(monkeypatch):
    _patch_builders(monkeypatch)
    pose_manager.get("mock")
    pose_manager.get("mock")
    src = FakePose.instances[0]
    pose_manager.release("mock")
    assert src.closed is False
    assert pose_manager._refs["mock"] == 1
    pose_manager.release("mock")
    assert src.closed is True
    assert "mock" not in pose_manager._refs
    assert "mock" not in pose_manager._sources


def test_unknown_source_raises(monkeypatch):
    _patch_builders(monkeypatch)
    with pytest.raises(ValueError, match="unknown pose source"):
        pose_manager.get("nope")


def test_release_unknown_is_noop(monkeypatch):
    _patch_builders(monkeypatch)
    pose_manager.release("never-acquired")  # must not raise
