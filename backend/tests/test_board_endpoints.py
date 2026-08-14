"""Route-level tests for /board/preview.png and /board/export.

The rendering itself is covered by tests/test_boardgen.py — this file checks the
routes hand back what the UI and the printer need: a PNG the detector can still
read, and a PDF whose page is the real paper size.
"""
from __future__ import annotations

import re

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.calib import _io
from app.main import app
from app.models import Board

BOARD_PARAMS = {
    "board_type": "charuco",
    "cols": 7,
    "rows": 5,
    "square": 0.025,
    "marker": 0.019,
    "dictionary": "DICT_5X5_100",
}
BOARD = Board(type="charuco", cols=7, rows=5, square=0.025, marker=0.019,
              dictionary="DICT_5X5_100")


@pytest.fixture
def client():
    return TestClient(app)


def test_preview_page_is_a_png_the_detector_still_reads(client):
    resp = client.get("/board/preview.png", params={
        **BOARD_PARAMS, "mode": "page", "dpi": 150, "paper": "A4", "margin_mm": 10,
    })

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "image/png"
    image = cv2.imdecode(np.frombuffer(resp.content, np.uint8), cv2.IMREAD_GRAYSCALE)
    result = _io.detect_charuco(image, BOARD)
    assert result is not None
    assert len(result[0]) == (BOARD.cols - 1) * (BOARD.rows - 1)


def test_export_pdf_page_is_the_real_paper_size(client, tmp_path):
    """The PDF states its page in points, so printing at 100% is metrically exact
    — that is the entire reason PDF exists here alongside PNG."""
    out = tmp_path / "board.pdf"

    resp = client.post("/board/export", json={
        **BOARD_PARAMS, "mode": "page", "dpi": 300, "paper": "A4",
        "margin_mm": 10, "format": "pdf", "path": str(out),
    })

    assert resp.status_code == 200, resp.text
    assert resp.json()["path"] == str(out)
    box = re.search(rb"/MediaBox\s*\[([^\]]*)\]", out.read_bytes())
    assert box is not None
    _x0, _y0, width_pt, height_pt = (float(v) for v in box.group(1).split())
    assert width_pt == pytest.approx(210 / 25.4 * 72, abs=0.5)
    assert height_pt == pytest.approx(297 / 25.4 * 72, abs=0.5)


def test_preview_reports_a_board_too_large_for_the_paper_as_a_user_error(client):
    """The app's default board is 540 x 405 mm, so A4 is the first thing the
    dialog hits. It has to come back as 400 with something actionable, not 500."""
    resp = client.get("/board/preview.png", params={
        "board_type": "chess", "cols": 11, "rows": 8, "square": 0.045,
        "mode": "page", "dpi": 150, "paper": "A4", "margin_mm": 10,
    })

    assert resp.status_code == 400
    assert "does not fit" in resp.json()["detail"]


def test_preview_rejects_an_unknown_board_type(client):
    resp = client.get("/board/preview.png", params={
        **BOARD_PARAMS, "board_type": "hemisphere", "mode": "board", "dpi": 150,
    })

    assert resp.status_code == 400
