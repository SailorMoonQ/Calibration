"""Tests for the /recording/import_mcap endpoint."""
from __future__ import annotations

import json
import os

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _build_fixture_mcap(path: str, n: int = 5):
    """Build a tiny MCAP with N foxglove.PoseInFrame messages on /robot0/vio/eef_pose,
    timestamps starting at epoch ts0 spaced 0.1s apart, identity rotation, position x=i."""
    from mcap_protobuf.writer import Writer
    from foxglove_schemas_protobuf.PoseInFrame_pb2 import PoseInFrame

    ts0 = 1_775_381_900_000_000_000  # ns
    with open(path, "wb") as f, Writer(f) as writer:
        for i in range(n):
            ts_ns = ts0 + i * 100_000_000
            msg = PoseInFrame()
            msg.timestamp.seconds = ts_ns // 1_000_000_000
            msg.timestamp.nanos = ts_ns % 1_000_000_000
            msg.frame_id = "world"
            msg.pose.position.x = float(i)
            msg.pose.position.y = 0.0
            msg.pose.position.z = 0.0
            msg.pose.orientation.x = 0.0
            msg.pose.orientation.y = 0.0
            msg.pose.orientation.z = 0.0
            msg.pose.orientation.w = 1.0
            writer.write_message(
                topic="/robot0/vio/eef_pose",
                message=msg,
                log_time=ts_ns,
                publish_time=ts_ns,
            )


def test_import_mcap_extracts_pose_in_frame(client, tmp_path):
    mcap_path = tmp_path / "tiny.mcap"
    out_path = tmp_path / "umi.json"
    _build_fixture_mcap(str(mcap_path), n=5)

    resp = client.post("/recording/import_mcap", json={
        "mcap_path": str(mcap_path),
        "topic": "/robot0/vio/eef_pose",
        "out_path": str(out_path),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["count"] == 5
    # t_first should be the epoch seconds of the first message.
    assert abs(body["t_first"] - 1_775_381_900.0) < 1e-3

    # Verify the output JSON.
    with open(out_path) as f:
        data = json.load(f)
    assert data["meta"]["kind"] == "umi"
    assert data["meta"]["n"] == 5
    assert len(data["samples"]) == 5
    # First sample: identity rotation, position (0, 0, 0).
    T0 = np.array(data["samples"][0]["T"], dtype=float)
    assert T0.shape == (4, 4)
    assert np.allclose(T0[:3, :3], np.eye(3))
    assert np.allclose(T0[:3, 3], [0, 0, 0])
    # Third sample: position x=2.
    T2 = np.array(data["samples"][2]["T"], dtype=float)
    assert np.allclose(T2[:3, 3], [2, 0, 0])


def test_import_mcap_unknown_topic_returns_400(client, tmp_path):
    mcap_path = tmp_path / "tiny.mcap"
    out_path = tmp_path / "umi.json"
    _build_fixture_mcap(str(mcap_path), n=2)

    resp = client.post("/recording/import_mcap", json={
        "mcap_path": str(mcap_path),
        "topic": "/does/not/exist",
        "out_path": str(out_path),
    })
    assert resp.status_code == 400
