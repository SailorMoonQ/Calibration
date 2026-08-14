from __future__ import annotations

import cv2
import pytest

from app.calib import _io, boardgen
from app.models import Board


def test_rendered_charuco_is_detected_with_every_corner() -> None:
    """The generator and the detector must agree by construction — a board we
    printed that the solver can only half-see is the failure this guards."""
    board = Board(type="charuco", cols=11, rows=8, square=0.045, marker=0.034,
                  dictionary="DICT_5X5_100")

    image = boardgen.render_board(board, dpi=150)
    result = _io.detect_charuco(image, board)

    assert result is not None
    corners, _object_points = result
    assert len(corners) == (board.cols - 1) * (board.rows - 1)


def test_rendered_chessboard_has_the_requested_inner_corner_count() -> None:
    """`cols`/`rows` count inner corners for chess boards, so the drawn grid has
    one more square in each direction — off by one here and every printed chess
    board is silently the wrong size."""
    board = Board(type="chess", cols=9, rows=6, square=0.025)

    image = boardgen.render_board(board, dpi=150)
    # The bare board runs to the image edge; `compose_page` is what supplies the
    # quiet zone in print, and OpenCV needs one to find the outer corners.
    padded = cv2.copyMakeBorder(image, 60, 60, 60, 60, cv2.BORDER_CONSTANT, value=255)
    corners = _io.detect_chessboard(padded, board.cols, board.rows)

    assert corners is not None
    assert len(corners) == board.cols * board.rows


def test_render_reports_the_square_size_it_actually_printed() -> None:
    """A whole number of pixels per square means the printed square is never
    exactly the requested one. That residue is a systematic scale error in
    `square`, so the value actually committed to paper has to be recoverable."""
    board = Board(type="chess", cols=9, rows=6, square=0.025)
    dpi = 300

    image = boardgen.render_board(board, dpi)
    actual = boardgen.actual_square_m(board.square, dpi)

    printed_width_m = image.shape[1] / dpi * 0.0254
    assert printed_width_m == pytest.approx((board.cols + 1) * actual)
    assert abs(actual - board.square) < 0.5 / dpi * 0.0254


def test_composed_page_is_the_paper_size_at_the_requested_dpi() -> None:
    board = Board(type="charuco", cols=7, rows=5, square=0.025, marker=0.019)
    dpi = 150

    page = boardgen.compose_page(board, dpi=dpi, paper="A4", margin_mm=10)

    height, width = page.shape[:2]
    printed_mm = sorted((round(width / dpi * 25.4), round(height / dpi * 25.4)))
    assert printed_mm == [210, 297]


def test_compose_page_refuses_a_board_too_large_for_the_paper() -> None:
    """Shrinking to fit would silently destroy the printed square size, which is
    the one property this whole feature exists to get right. Refuse instead."""
    board = Board(type="chess", cols=11, rows=8, square=0.045)  # 540 × 405 mm

    with pytest.raises(ValueError, match="does not fit"):
        boardgen.compose_page(board, dpi=150, paper="A4", margin_mm=10)


def test_page_caption_quotes_the_square_size_that_reached_the_paper() -> None:
    """25 mm requested at 300 dpi lands as 24.977 mm. The caption is what the
    operator copies back into `square`, so it has to quote the printed value."""
    board = Board(type="chess", cols=9, rows=6, square=0.025)

    caption = " ".join(boardgen.page_caption(board, dpi=300))

    assert "24.977" in caption


def test_composed_page_leaves_the_board_fully_detectable() -> None:
    """Guards the page layout: caption furniture that overlaps or clips the board
    would still produce a plausible-looking print."""
    board = Board(type="charuco", cols=7, rows=5, square=0.025, marker=0.019)

    page = boardgen.compose_page(board, dpi=150, paper="A4", margin_mm=10)
    result = _io.detect_charuco(page, board)

    assert result is not None
    corners, _object_points = result
    assert len(corners) == (board.cols - 1) * (board.rows - 1)
