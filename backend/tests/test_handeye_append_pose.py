"""POST /handeye/append_pose appends one entry to poses.json (creating it on
first call), writes poses.meta.json on first call only, and uses an atomic
rename so an interrupted write leaves the previous file intact."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app


def _eye4():
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def _post(client, **body):
    return client.post("/handeye/append_pose", json=body)


def test_first_call_creates_poses_and_meta(tmp_path):
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    r = _post(client,
              poses_path=poses_path,
              basename="f1.png", T=_eye4(), ts=1.0,
              meta={"tracker_source": "mock", "device": "d0", "kind": "hmd"})
    assert r.status_code == 200, r.text
    data = json.loads(Path(poses_path).read_text())
    assert "f1.png" in data
    assert data["f1.png"]["T"] == _eye4()
    assert data["f1.png"]["ts"] == 1.0
    meta = json.loads(Path(tmp_path / "poses.meta.json").read_text())
    assert meta["tracker_source"] == "mock"
    assert meta["device"] == "d0"
    assert meta["kind"] == "hmd"
    assert meta["n"] == 1


def test_second_call_appends_and_updates_meta_count(tmp_path):
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    meta = {"tracker_source": "mock", "device": "d0", "kind": "hmd"}
    _post(client, poses_path=poses_path, basename="f1.png", T=_eye4(), ts=1.0, meta=meta)
    _post(client, poses_path=poses_path, basename="f2.png", T=_eye4(), ts=2.0, meta=meta)
    data = json.loads(Path(poses_path).read_text())
    assert set(data.keys()) == {"f1.png", "f2.png"}
    meta_on_disk = json.loads(Path(tmp_path / "poses.meta.json").read_text())
    assert meta_on_disk["n"] == 2


def test_meta_only_set_once(tmp_path):
    """Renderer sends `meta` on every call but the backend must keep the
    first-call meta intact even if the renderer's meta drifts later."""
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    _post(client, poses_path=poses_path, basename="f1.png", T=_eye4(), ts=1.0,
          meta={"tracker_source": "steamvr", "device": "LHR-A", "kind": "hmd"})
    _post(client, poses_path=poses_path, basename="f2.png", T=_eye4(), ts=2.0,
          meta={"tracker_source": "oculus", "device": "quest3", "kind": "ctrl"})
    meta = json.loads(Path(tmp_path / "poses.meta.json").read_text())
    assert meta["tracker_source"] == "steamvr"
    assert meta["device"] == "LHR-A"
    assert meta["kind"] == "hmd"
    assert meta["n"] == 2


def test_missing_fields_rejected(tmp_path):
    client = TestClient(app)
    r = _post(client, basename="f1.png", T=_eye4(), ts=1.0)  # no poses_path
    assert r.status_code == 400
    r = _post(client, poses_path=str(tmp_path / "poses.json"), T=_eye4(), ts=1.0)
    assert r.status_code == 400
    r = _post(client, poses_path=str(tmp_path / "poses.json"), basename="f1.png", ts=1.0)
    assert r.status_code == 400


def test_wrong_T_shape_rejected(tmp_path):
    client = TestClient(app)
    r = _post(client,
              poses_path=str(tmp_path / "poses.json"),
              basename="f1.png", T=[[1, 2, 3]], ts=1.0)
    assert r.status_code == 400


def test_atomic_write_via_rename(tmp_path, monkeypatch):
    """If json.dump succeeds but os.replace fails, poses.json must be
    untouched (or never created). Verifies we use the tmp+rename pattern."""
    client = TestClient(app)
    poses_path = str(tmp_path / "poses.json")
    # Seed with one entry first.
    _post(client, poses_path=poses_path, basename="f1.png", T=_eye4(), ts=1.0,
          meta={"tracker_source": "mock", "device": "d", "kind": "hmd"})
    original = Path(poses_path).read_text()

    import app.api.routes as routes
    real_replace = __import__("os").replace
    calls = {"n": 0}
    def fail_then_succeed(src, dst):
        calls["n"] += 1
        if calls["n"] == 1:  # first replace = poses.json
            raise OSError("simulated failure")
        return real_replace(src, dst)
    monkeypatch.setattr(routes.os, "replace", fail_then_succeed)

    r = _post(client, poses_path=poses_path, basename="f2.png", T=_eye4(), ts=2.0,
              meta={"tracker_source": "mock", "device": "d", "kind": "hmd"})
    assert r.status_code == 500
    assert Path(poses_path).read_text() == original  # untouched
