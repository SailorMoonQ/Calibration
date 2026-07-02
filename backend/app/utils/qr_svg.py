from __future__ import annotations

from functools import lru_cache


# Minimal QR encoder for byte-mode payloads used as a dependency-free fallback.
# Versions 1-5 at error correction level L cover URLs up to 106 UTF-8 bytes.
_VERSION_TABLE = {
    1: (19, 7),
    2: (34, 10),
    3: (55, 15),
    4: (80, 20),
    5: (108, 26),
}
_ALIGNMENT_CENTERS = {
    1: (),
    2: (6, 18),
    3: (6, 22),
    4: (6, 26),
    5: (6, 30),
}


def qrcode_svg(payload: str, *, border: int = 4) -> bytes:
    matrix = make_qr_matrix(payload)
    size = len(matrix)
    view_size = size + border * 2
    parts: list[str] = []
    for y, row in enumerate(matrix):
        for x, dark in enumerate(row):
            if dark:
                parts.append(f"M{x + border},{y + border}h1v1h-1z")
    path = "".join(parts)
    svg = (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        f"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {view_size} {view_size}\" "
        "shape-rendering=\"crispEdges\">\n"
        "<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>\n"
        f"<path d=\"{path}\" fill=\"#000\"/>\n"
        "</svg>"
    )
    return svg.encode("utf-8")


def make_qr_matrix(payload: str) -> list[list[bool]]:
    data = payload.encode("utf-8")
    version = _choose_version(len(data))
    data_codewords, ecc_codewords = _VERSION_TABLE[version]
    codewords = _encode_data_codewords(data, data_codewords)
    codewords.extend(_reed_solomon_remainder(codewords, ecc_codewords))
    return _draw_matrix(version, codewords)


def _choose_version(data_len: int) -> int:
    bit_len = 4 + 8 + data_len * 8
    for version, (data_codewords, _ecc_codewords) in _VERSION_TABLE.items():
        if bit_len <= data_codewords * 8:
            return version
    raise ValueError("payload too long for built-in QR generator")


def _encode_data_codewords(data: bytes, data_codewords: int) -> list[int]:
    bits: list[int] = []
    _append_bits(bits, 0b0100, 4)  # byte mode
    _append_bits(bits, len(data), 8)
    for byte in data:
        _append_bits(bits, byte, 8)

    capacity = data_codewords * 8
    bits.extend([0] * min(4, capacity - len(bits)))
    while len(bits) % 8:
        bits.append(0)

    codewords: list[int] = []
    for i in range(0, len(bits), 8):
        byte = 0
        for bit in bits[i:i + 8]:
            byte = (byte << 1) | bit
        codewords.append(byte)

    pad = 0
    while len(codewords) < data_codewords:
        codewords.append(0xEC if pad % 2 == 0 else 0x11)
        pad += 1
    return codewords


def _append_bits(bits: list[int], value: int, length: int) -> None:
    for shift in range(length - 1, -1, -1):
        bits.append((value >> shift) & 1)


def _draw_matrix(version: int, codewords: list[int]) -> list[list[bool]]:
    size = version * 4 + 17
    modules = [[False] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    def set_function(x: int, y: int, dark: bool) -> None:
        modules[y][x] = dark
        reserved[y][x] = True

    def reserve(x: int, y: int) -> None:
        reserved[y][x] = True

    def draw_finder(x: int, y: int) -> None:
        for yy in range(y - 1, y + 8):
            for xx in range(x - 1, x + 8):
                if not (0 <= xx < size and 0 <= yy < size):
                    continue
                in_core = x <= xx < x + 7 and y <= yy < y + 7
                dark = False
                if in_core:
                    dx, dy = xx - x, yy - y
                    dark = (
                        dx in (0, 6)
                        or dy in (0, 6)
                        or (2 <= dx <= 4 and 2 <= dy <= 4)
                    )
                set_function(xx, yy, dark)

    def draw_alignment(cx: int, cy: int) -> None:
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                dist = max(abs(dx), abs(dy))
                set_function(cx + dx, cy + dy, dist in (0, 2))

    draw_finder(0, 0)
    draw_finder(size - 7, 0)
    draw_finder(0, size - 7)

    for i in range(8, size - 8):
        dark = i % 2 == 0
        set_function(i, 6, dark)
        set_function(6, i, dark)

    centers = _ALIGNMENT_CENTERS[version]
    for cy in centers:
        for cx in centers:
            if reserved[cy][cx]:
                continue
            draw_alignment(cx, cy)

    for i in range(9):
        if i != 6:
            reserve(8, i)
            reserve(i, 8)
    for i in range(8):
        reserve(size - 1 - i, 8)
    for i in range(7):
        reserve(8, size - 1 - i)
    set_function(8, size - 8, True)

    bits = [(codeword >> shift) & 1 for codeword in codewords for shift in range(7, -1, -1)]
    bit_index = 0
    upward = True
    x = size - 1
    while x > 0:
        if x == 6:
            x -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for y in rows:
            for xx in (x, x - 1):
                if reserved[y][xx]:
                    continue
                bit = bits[bit_index] if bit_index < len(bits) else 0
                bit_index += 1
                modules[y][xx] = bool(bit) ^ _mask0(xx, y)
        upward = not upward
        x -= 2

    _draw_format_bits(set_function, size)
    return modules


def _mask0(x: int, y: int) -> bool:
    return (x + y) % 2 == 0


def _draw_format_bits(set_function, size: int) -> None:
    bits = _format_bits(mask=0)
    for i in range(6):
        set_function(8, i, _bit(bits, i))
    set_function(8, 7, _bit(bits, 6))
    set_function(8, 8, _bit(bits, 7))
    set_function(7, 8, _bit(bits, 8))
    for i in range(9, 15):
        set_function(14 - i, 8, _bit(bits, i))

    for i in range(8):
        set_function(size - 1 - i, 8, _bit(bits, i))
    for i in range(8, 15):
        set_function(8, size - 15 + i, _bit(bits, i))
    set_function(8, size - 8, True)


def _format_bits(mask: int) -> int:
    data = (0b01 << 3) | mask  # error correction level L
    rem = data << 10
    for i in range(14, 9, -1):
        if (rem >> i) & 1:
            rem ^= 0x537 << (i - 10)
    return ((data << 10) | rem) ^ 0x5412


def _bit(value: int, index: int) -> bool:
    return ((value >> index) & 1) != 0


@lru_cache(maxsize=None)
def _gf_tables() -> tuple[list[int], list[int]]:
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    exp, log = _gf_tables()
    return exp[log[a] + log[b]]


@lru_cache(maxsize=None)
def _rs_generator(degree: int) -> tuple[int, ...]:
    poly = [1]
    exp, _log = _gf_tables()
    for i in range(degree):
        poly = _poly_mul(poly, [1, exp[i]])
    return tuple(poly)


def _poly_mul(a: list[int], b: list[int]) -> list[int]:
    out = [0] * (len(a) + len(b) - 1)
    for i, av in enumerate(a):
        for j, bv in enumerate(b):
            out[i + j] ^= _gf_mul(av, bv)
    return out


def _reed_solomon_remainder(data: list[int], degree: int) -> list[int]:
    gen = _rs_generator(degree)
    msg = data[:] + [0] * degree
    for i in range(len(data)):
        coef = msg[i]
        if coef == 0:
            continue
        for j, gen_coef in enumerate(gen):
            msg[i + j] ^= _gf_mul(gen_coef, coef)
    return msg[-degree:]
