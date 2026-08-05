import json

import numpy as np
import pytest

from app.sources import roi_store as rs
from app.sources.opencv import CameraSource


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    p = tmp_path / "camera-roi.json"
    monkeypatch.setenv("CALIB_ROI_STORE", str(p))
    return p


def frame(w, h):
    """A frame whose every pixel encodes its own coordinates, so a crop can be
    checked by reading values rather than by comparing shapes alone."""
    f = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        for x in range(w):
            f[y, x] = (x % 256, y % 256, 0)
    return f


# ── the crop itself ─────────────────────────────────────────────────────────

def test_no_roi_passes_the_frame_through():
    src = CameraSource("/dev/video0")
    f = frame(64, 48)
    assert src._maybe_roi(f) is f


def test_roi_crops_to_the_requested_window():
    src = CameraSource("/dev/video0")
    src.set_roi(10, 5, 20, 15)
    out = src._maybe_roi(frame(64, 48))
    assert out.shape[:2] == (15, 20)
    # Top-left of the crop must be the pixel at (10, 5) of the source.
    assert tuple(out[0, 0][:2]) == (10, 5)
    assert tuple(out[14, 19][:2]) == (29, 19)


def test_roi_is_a_pure_slice_with_no_resize():
    # A resize would change fx/fy and defeat the whole point of the feature.
    src = CameraSource("/dev/video0")
    src.set_roi(0, 0, 32, 24)
    out = src._maybe_roi(frame(64, 48))
    assert out.shape[:2] == (24, 32)
    assert tuple(out[0, 0][:2]) == (0, 0)
    assert tuple(out[23, 31][:2]) == (31, 23)


def test_full_frame_roi_returns_the_original_object():
    src = CameraSource("/dev/video0")
    f = frame(64, 48)
    src.set_roi(0, 0, 64, 48)
    assert src._maybe_roi(f) is f, "a no-op ROI should not copy"


def test_roi_larger_than_the_frame_is_clamped_not_fatal():
    # Happens when an ROI saved at 1920x1080 is replayed on a 640x480 stream.
    src = CameraSource("/dev/video0")
    src.set_roi(0, 0, 9999, 9999)
    out = src._maybe_roi(frame(64, 48))
    assert out.shape[:2] == (48, 64)


def test_roi_offset_beyond_the_frame_is_clamped():
    src = CameraSource("/dev/video0")
    src.set_roi(1000, 1000, 20, 20)
    out = src._maybe_roi(frame(64, 48))
    assert out.shape[0] >= 1 and out.shape[1] >= 1


def test_roi_partially_outside_keeps_what_fits():
    src = CameraSource("/dev/video0")
    src.set_roi(50, 40, 30, 30)
    out = src._maybe_roi(frame(64, 48))
    assert out.shape[:2] == (8, 14)   # 48-40 tall, 64-50 wide


def test_set_roi_with_zero_size_clears_it():
    src = CameraSource("/dev/video0")
    src.set_roi(10, 10, 20, 20)
    assert src.get_roi() is not None
    src.set_roi(0, 0, 0, 0)
    assert src.get_roi() is None
    f = frame(64, 48)
    assert src._maybe_roi(f) is f


def test_get_roi_reports_what_was_set():
    src = CameraSource("/dev/video0")
    src.set_roi(3, 4, 5, 6)
    assert src.get_roi() == {"left": 3, "top": 4, "width": 5, "height": 6}


def test_roi_runs_after_clip_so_it_sees_clipped_coordinates():
    # The clip is a centred downscale; the ROI is expressed in the coordinates
    # consumers see, i.e. AFTER that. Composing them the other way round would
    # make a (cx, cy) measured on the live stream meaningless as ROI input.
    src = CameraSource("/dev/video0")
    src.set_clip(100, 100)
    src.set_roi(0, 0, 40, 40)
    clipped = src._maybe_clip(frame(400, 300))
    assert max(clipped.shape[:2]) <= 100
    out = src._maybe_roi(clipped)
    assert out.shape[:2] == (40, 40)


def test_none_frame_is_tolerated():
    src = CameraSource("/dev/video0")
    src.set_roi(1, 1, 5, 5)
    assert src._maybe_roi(None) is None


# ── persistence ─────────────────────────────────────────────────────────────

def test_missing_store_reads_as_no_roi():
    assert rs.get_roi("cam1") is None


def test_round_trip():
    rs.set_roi("cam1", "serial", {"left": 10, "top": 20, "width": 100, "height": 80})
    assert rs.get_roi("cam1") == {"left": 10, "top": 20, "width": 100, "height": 80}


def test_clearing_removes_the_record():
    rs.set_roi("cam1", "serial", {"left": 1, "top": 2, "width": 3, "height": 4})
    rs.set_roi("cam1", "serial", None)
    assert rs.get_roi("cam1") is None


def test_devices_are_independent():
    rs.set_roi("cam1", "serial", {"left": 1, "top": 1, "width": 10, "height": 10})
    rs.set_roi("cam2", "serial", {"left": 2, "top": 2, "width": 20, "height": 20})
    assert rs.get_roi("cam1")["width"] == 10
    assert rs.get_roi("cam2")["width"] == 20


def test_corrupt_store_reads_as_no_roi(store):
    store.write_text("{{{ not json")
    assert rs.get_roi("cam1") is None


def test_incomplete_record_reads_as_no_roi(store):
    store.write_text(json.dumps({"version": 1, "devices": {"cam1": {"left": 0, "top": 0}}}))
    # A half-written ROI must not become a crop nobody asked for.
    assert rs.get_roi("cam1") is None


def test_non_positive_size_reads_as_no_roi(store):
    store.write_text(json.dumps({
        "version": 1,
        "devices": {"cam1": {"left": 0, "top": 0, "width": 0, "height": 10}},
    }))
    assert rs.get_roi("cam1") is None


def test_negative_origin_reads_as_no_roi(store):
    store.write_text(json.dumps({
        "version": 1,
        "devices": {"cam1": {"left": -5, "top": 0, "width": 10, "height": 10}},
    }))
    assert rs.get_roi("cam1") is None


def test_write_leaves_no_temp_files(store):
    rs.set_roi("cam1", "serial", {"left": 1, "top": 2, "width": 3, "height": 4})
    assert list(store.parent.glob(".camera-roi-*.tmp")) == []


def test_keyed_by_is_recorded(store):
    rs.set_roi("/dev/video0", "path", {"left": 1, "top": 2, "width": 3, "height": 4})
    assert json.loads(store.read_text())["devices"]["/dev/video0"]["keyed_by"] == "path"
