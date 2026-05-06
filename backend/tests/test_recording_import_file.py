"""Tests for the /recording/import_file endpoint (json + yaml normalization)."""
from __future__ import annotations

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _identity_T():
    return np.eye(4).tolist()


def _write_json_recording(path, *, n=4, device="tracker_0"):
    doc = {
        "meta": {"kind": "vive", "n": n, "t_first": 1000.0, "t_last": 1000.0 + n * 0.1, "device": device},
        "samples": [{"ts": 1000.0 + i * 0.1, "T": _identity_T()} for i in range(n)],
    }
    with open(path, "w") as f:
        json.dump(doc, f)


def test_import_file_json_roundtrip(client, tmp_path):
    src = tmp_path / "rec.json"
    _write_json_recording(str(src), n=4, device="tracker_0")

    resp = client.post("/recording/import_file", json={
        "path": str(src),
        "format": "json",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["count"] == 4
    assert abs(body["t_first"] - 1000.0) < 1e-6
    assert abs(body["t_last"] - 1000.3) < 1e-6
    assert body["device"] == "tracker_0"
    # JSON inputs are returned as-is (no rewrite needed).
    assert body["path"] == str(src)
