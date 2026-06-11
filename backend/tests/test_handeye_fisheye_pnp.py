from __future__ import annotations

import numpy as np

from app.calib import handeye
from app.models import Board, HandEyeRequest


def test_build_A_from_dataset_undistorts_fisheye_points(monkeypatch, tmp_path):
    img_path = tmp_path / "frame.png"
    img_path.write_bytes(b"not decoded in this test")

    image_points = np.array([[100.0, 120.0], [160.0, 122.0], [161.0, 180.0], [99.0, 181.0]])
    object_points = np.array([[0.0, 0.0, 0.0], [0.04, 0.0, 0.0], [0.04, 0.04, 0.0], [0.0, 0.04, 0.0]])
    calls = {"undistort": 0, "solve_dist": None}

    monkeypatch.setattr(handeye._io, "list_dataset", lambda _path: [str(img_path)])
    monkeypatch.setattr(handeye._io, "load_image_gray", lambda _path: (np.zeros((240, 320), dtype=np.uint8), (320, 240)))
    monkeypatch.setattr(handeye._io, "detect_board", lambda _gray, _board: (image_points, object_points))

    def fake_undistort_points(points, K, D, P=None):
        calls["undistort"] += 1
        assert D.shape == (4, 1)
        assert P is K
        return points

    def fake_solve_pnp(obj, img, K, D, flags):
        calls["solve_dist"] = D.copy()
        return True, np.zeros((3, 1), dtype=np.float64), np.zeros((3, 1), dtype=np.float64)

    monkeypatch.setattr(handeye.cv2.fisheye, "undistortPoints", fake_undistort_points)
    monkeypatch.setattr(handeye.cv2, "solvePnP", fake_solve_pnp)

    req = HandEyeRequest(
        board=Board(cols=2, rows=2, square=0.04),
        dataset_path=str(tmp_path),
        K=[[420.0, 0.0, 160.0], [0.0, 421.0, 120.0], [0.0, 0.0, 1.0]],
        D=[-0.18, 0.01, 0.001, 0.0],
        distortion_model="fisheye",
    )
    A, names = handeye._build_A_from_dataset(req)

    assert len(A) == 1
    assert names == ["frame.png"]
    assert calls["undistort"] == 1
    assert np.allclose(calls["solve_dist"], np.zeros((4, 1)))

