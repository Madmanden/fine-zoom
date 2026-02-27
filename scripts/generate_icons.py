#!/usr/bin/env python3
"""Generate extension PNG icons with a high-contrast glyph."""

from pathlib import Path
import math
import struct
import zlib

START_COLOR = (102, 126, 234)
END_COLOR = (118, 75, 162)


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def _dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    if ab2 == 0:
        return math.hypot(apx, apy)
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
    cx, cy = ax + t * abx, ay + t * aby
    return math.hypot(px - cx, py - cy)


def _draw_z(x: int, y: int, size: int, shadow: bool = False) -> bool:
    pad = size * 0.24
    left, right = pad, size - pad
    top, bottom = pad, size - pad
    ox = size * 0.06 if shadow else 0.0
    oy = size * 0.06 if shadow else 0.0

    stroke = max(1.25, size * (0.11 if shadow else 0.095))
    px, py = x + 0.5, y + 0.5

    d_top = _dist_to_segment(px, py, left + ox, top + oy, right + ox, top + oy)
    d_diag = _dist_to_segment(px, py, right + ox, top + oy, left + ox, bottom + oy)
    d_bottom = _dist_to_segment(px, py, left + ox, bottom + oy, right + ox, bottom + oy)
    return min(d_top, d_diag, d_bottom) <= stroke


def _create_icon(size: int) -> bytes:
    width = height = size
    radius = max(2, round(size * 20 / 128))

    rows: list[bytes] = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            inside = True
            if x < radius and y < radius:
                inside = (x - radius) ** 2 + (y - radius) ** 2 <= radius * radius
            elif x >= width - radius and y < radius:
                inside = (x - (width - radius - 1)) ** 2 + (y - radius) ** 2 <= radius * radius
            elif x < radius and y >= height - radius:
                inside = (x - radius) ** 2 + (y - (height - radius - 1)) ** 2 <= radius * radius
            elif x >= width - radius and y >= height - radius:
                inside = (x - (width - radius - 1)) ** 2 + (y - (height - radius - 1)) ** 2 <= radius * radius

            if not inside:
                row.extend((0, 0, 0, 0))
                continue

            blend = (x + y) / (width + height - 2)
            r = round(START_COLOR[0] * (1 - blend) + END_COLOR[0] * blend)
            g = round(START_COLOR[1] * (1 - blend) + END_COLOR[1] * blend)
            b = round(START_COLOR[2] * (1 - blend) + END_COLOR[2] * blend)

            if _draw_z(x, y, size, shadow=True):
                r, g, b = 48, 35, 84
            if _draw_z(x, y, size, shadow=False):
                r, g, b = 255, 255, 255

            row.extend((r, g, b, 255))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + row for row in rows)
    compressed = zlib.compress(raw, 9)

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png.extend(_png_chunk(b"IHDR", ihdr))
    png.extend(_png_chunk(b"IDAT", compressed))
    png.extend(_png_chunk(b"IEND", b""))
    return bytes(png)


def main() -> None:
    out_dir = Path("icons")
    for size in (16, 48, 128):
        (out_dir / f"icon{size}.png").write_bytes(_create_icon(size))
    print("Generated icon16.png, icon48.png, icon128.png")


if __name__ == "__main__":
    main()
