"""Route-level tests for /recording/sync alias handling.

The pure sync_streams helper is exercised by tests/test_sync.py — this file only
checks the route accepts the new a_path/b_path keys identically to the legacy
vive_path/umi_path keys, and that the response carries the new a_rot_deg / b_rot_deg
mirrors of the existing vive_rot_deg / umi_rot_deg fields.
"""
from __future__ import annotations

import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _write_recording(path, *, t_start, n=300, dt=1 / 30):
    samples = []
    for i in range(n):
        t = t_start + i * dt
        ang = i * dt * 1.0
        c, s = math.cos(ang), math.sin(ang)
        T = np.eye(4)
        T[:3, :3] = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)
        T[:3, 3] = [c, s, 0.5 * math.sin(2 * ang)]
        samples.append({"ts": t, "T": T.tolist()})
    doc = {"meta": {"kind": "rec", "n": n, "t_first": samples[0]["ts"],
                     "t_last": samples[-1]["ts"]}, "samples": samples}
    with open(path, "w") as f:
        json.dump(doc, f)


def test_sync_accepts_a_path_b_path(client, tmp_path):
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    out = tmp_path / "synced.json"
    _write_recording(str(a), t_start=1000.0)
    _write_recording(str(b), t_start=1000.3)

    resp = client.post("/recording/sync", json={
        "a_path": str(a),
        "b_path": str(b),
        "out_path": str(out),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["n_pairs"] >= 200
    # New fields mirror the legacy ones.
    assert "a_rot_deg" in body and "b_rot_deg" in body
    assert body["a_rot_deg"] == body["vive_rot_deg"]
    assert body["b_rot_deg"] == body["umi_rot_deg"]


def test_sync_legacy_vive_umi_keys_still_work(client, tmp_path):
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    out = tmp_path / "synced.json"
    _write_recording(str(a), t_start=2000.0)
    _write_recording(str(b), t_start=2000.0)

    resp = client.post("/recording/sync", json={
        "vive_path": str(a),
        "umi_path": str(b),
        "out_path": str(out),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "a_rot_deg" in body
