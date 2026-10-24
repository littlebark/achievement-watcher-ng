# Generate a 32x32 trophy tray icon (RGBA PNG) without third-party libs.
import struct, zlib, os

W = H = 32
GOLD = (232, 195, 82, 255)
DGOLD = (184, 134, 11, 255)
SHINE = (255, 243, 205, 255)
TRANS = (0, 0, 0, 0)

px = [[TRANS] * W for _ in range(H)]

def put(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = c

# Cup bowl: rows 4..13, x 8..23, rounded corners
for y in range(4, 14):
    for x in range(8, 24):
        # round the bowl: trim corners progressively near bottom
        inset = 0
        if y >= 11: inset = y - 10
        if x < 8 + inset or x > 23 - inset:
            continue
        c = GOLD
        if y == 4:  # rim
            c = SHINE if x <= 12 else GOLD
        elif x >= 20:  # right inner shading
            c = DGOLD
        put(x, y, c)

# Handles: rings centered at (6.5, 8) and (25.5, 8), radius 3.2..4.6
import math
for cy, cx in ((8.0, 6.5), (8.0, 25.5)):
    for y in range(3, 14):
        for x in range(1, 31):
            d = math.hypot(x - cx, y - cy)
            if 3.2 <= d <= 4.6 and 1 <= x <= 7 or 3.2 <= d <= 4.6 and 24 <= x <= 30:
                put(x, y, DGOLD)

# Stem
for y in range(14, 20):
    for x in range(13, 19):
        c = DGOLD if x in (13, 18) else GOLD
        put(x, y, c)

# Base
for y in range(20, 24):
    for x in range(9, 23):
        c = DGOLD if y == 23 or x in (9, 22) else GOLD
        put(x, y, c)

# Shine on bowl left
for y in range(6, 10):
    put(10, y, SHINE)

raw = b""
for y in range(H):
    raw += b"\x00" + b"".join(struct.pack("4B", *px[y][x]) for x in range(W))

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tray.png")
with open(out, "wb") as f:
    f.write(png)
print("written", out, len(png), "bytes")
