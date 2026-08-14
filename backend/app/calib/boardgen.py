"""Renders printable calibration targets.

The board is built from the same `Board` model and the same ArUco dictionary
table (`_io._ARUCO_DICTS`) that the detector uses, so a board printed from here
and the board `CharucoDetector` expects cannot drift apart.

Note there is deliberately no `setLegacyPattern` call: OpenCV 4.7 changed the
ChArUco layout (the top-left square went from white to black) and the detector
here runs on the modern one. Boards from older generators are not compatible.
"""
from __future__ import annotations

import cv2
import numpy as np

from app.models import Board

from . import _io

_METRES_PER_INCH = 0.0254


def px_per_square(square_m: float, dpi: int) -> int:
    """Pixels per board square such that printing at 100% scale yields `square_m`."""
    return round(square_m / _METRES_PER_INCH * dpi)


# Short edge, long edge, in millimetres.
PAPER_MM: dict[str, tuple[float, float]] = {
    "A4": (210.0, 297.0),
    "A3": (297.0, 420.0),
    "A2": (420.0, 594.0),
    "A1": (594.0, 841.0),
    "A0": (841.0, 1189.0),
    "Letter": (215.9, 279.4),
}


def _mm_to_px(mm: float, dpi: int) -> int:
    return round(mm / 25.4 * dpi)


def actual_square_m(square_m: float, dpi: int) -> float:
    """The square size that reaches the paper, after rounding to whole pixels.

    Off from the requested `square_m` by up to half a pixel — small, but
    systematic across every square, so it lands in the solver as a scale error
    on the baseline and on hand-eye translation. Report it; don't absorb it.
    """
    return px_per_square(square_m, dpi) / dpi * _METRES_PER_INCH


def _render_chess(cols: int, rows: int, px: int) -> np.ndarray:
    """`cols`/`rows` are *inner corners*, so the grid is one square larger each way."""
    n_x, n_y = cols + 1, rows + 1
    image = np.full((n_y * px, n_x * px), 255, dtype=np.uint8)
    for iy in range(n_y):
        for ix in range(n_x):
            if (ix + iy) % 2 == 0:
                image[iy * px:(iy + 1) * px, ix * px:(ix + 1) * px] = 0
    return image


def _render_charuco(board: Board, px: int) -> np.ndarray:
    if board.marker is None:
        raise ValueError("charuco board requires `marker` size")
    dict_id = _io._ARUCO_DICTS.get(board.dictionary, cv2.aruco.DICT_5X5_100)
    dictionary = cv2.aruco.getPredefinedDictionary(dict_id)
    cb = cv2.aruco.CharucoBoard((board.cols, board.rows), board.square, board.marker, dictionary)
    return cb.generateImage((board.cols * px, board.rows * px))


def render_board(board: Board, dpi: int) -> np.ndarray:
    """The bare board, no margin — grayscale, printed size `cols × square` metres.

    Margins and page furniture belong to `compose_page`, not here.
    """
    px = px_per_square(board.square, dpi)
    if board.type == "chess":
        return _render_chess(board.cols, board.rows, px)
    if board.type == "charuco":
        return _render_charuco(board, px)
    raise ValueError(f"unknown board type: {board.type}")


def page_caption(board: Board, dpi: int) -> list[str]:
    """The block printed beside the board, in ASCII — Hershey has no CJK glyphs.

    It quotes the square size that actually reached the paper, not the one that
    was asked for: this text is what the operator copies back into `square`.
    """
    square_mm = actual_square_m(board.square, dpi) * 1000
    if board.type == "charuco":
        head = f"ChArUco  {board.cols} x {board.rows} squares  {board.dictionary}"
        # Marker length never reaches the solver — charuco object points come from
        # the squares alone — so one decimal, and no pretence of more.
        marker_mm = square_mm * (board.marker / board.square) if board.marker else 0.0
        sizes = f"square {square_mm:.3f} mm    marker {marker_mm:.1f} mm"
    else:
        head = f"Chessboard  {board.cols} x {board.rows} inner corners"
        sizes = f"square {square_mm:.3f} mm"
    return [
        head,
        sizes,
        f"rendered at {dpi} dpi - print at 100% scale, do NOT scale to fit",
        "measured square: ........ mm  <- measure it, then enter that value",
    ]


# Cap height of the caption text on paper. Big enough to read across a room,
# small enough not to steal board area on A4.
_CAPTION_MM = 3.2


def _caption_font(dpi: int) -> tuple[float, int, int]:
    """Returns (font_scale, thickness, line_height_px) for this dpi."""
    target_px = _CAPTION_MM / 25.4 * dpi
    (_w, h), _baseline = cv2.getTextSize("M", cv2.FONT_HERSHEY_SIMPLEX, 1.0, 1)
    scale = target_px / h
    thickness = max(1, round(scale * 1.8))
    return scale, thickness, round(target_px * 1.9)


def compose_page(board: Board, dpi: int, paper: str, margin_mm: float) -> np.ndarray:
    """The board on a sheet of `paper` at true printed size, with the caption below.

    Orientation is whichever of portrait/landscape the board fits in; a board that
    fits neither raises rather than being scaled down to suit.
    """
    image = render_board(board, dpi)
    board_h, board_w = image.shape[:2]
    margin = _mm_to_px(margin_mm, dpi)
    lines = page_caption(board, dpi)
    scale, thickness, line_h = _caption_font(dpi)
    caption_h = line_h * len(lines)

    short_mm, long_mm = PAPER_MM[paper]
    need_w, need_h = board_w + 2 * margin, board_h + 2 * margin + caption_h
    fitted = None
    for w_mm, h_mm in ((short_mm, long_mm), (long_mm, short_mm)):
        page_w, page_h = _mm_to_px(w_mm, dpi), _mm_to_px(h_mm, dpi)
        if need_w <= page_w and need_h <= page_h:
            fitted = (page_w, page_h)
            break
    if fitted is None:
        raise ValueError(
            f"board does not fit {paper}: needs {need_w / dpi * 25.4:.0f}x"
            f"{need_h / dpi * 25.4:.0f} mm including margins and caption, "
            f"{paper} is {short_mm:.0f}x{long_mm:.0f} mm"
        )
    page_w, page_h = fitted

    page = np.full((page_h, page_w), 255, dtype=np.uint8)
    x = (page_w - board_w) // 2
    y = margin + (page_h - 2 * margin - caption_h - board_h) // 2
    page[y:y + board_h, x:x + board_w] = image

    text_y = y + board_h + line_h
    for line in lines:
        cv2.putText(page, line, (x, text_y), cv2.FONT_HERSHEY_SIMPLEX,
                    scale, 0, thickness, cv2.LINE_AA)
        text_y += line_h
    return page
