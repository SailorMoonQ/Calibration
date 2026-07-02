from __future__ import annotations

import cv2
import numpy as np

from app.utils.qr_svg import make_qr_matrix, qrcode_svg


def test_builtin_qr_svg_encodes_mobile_url() -> None:
    url = "https://192.168.100.200:65535/mobile"
    matrix = np.array(make_qr_matrix(url), dtype=np.uint8)
    image = np.pad(matrix * 255, 4, constant_values=0)
    image = 255 - image
    image = cv2.resize(image, None, fx=10, fy=10, interpolation=cv2.INTER_NEAREST)

    decoded, _points, _straight = cv2.QRCodeDetector().detectAndDecode(image)

    assert decoded == url
    assert qrcode_svg(url).startswith(b"<?xml")
