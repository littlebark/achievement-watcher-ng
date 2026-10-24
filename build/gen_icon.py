# Generate build/icon.ico: 256x256 trophy (8x blocks from the 32px design), PNG-in-ICO.
import struct, zlib, os, math

S = 8               # each 32px design pixel becomes an 8x8 block
W = H = 32 * S      # 256
GOLD = (232, 195, 82, 255)
DGOLD = (184, 134, 11, 255)
SHINE = (255, 243, 205, 255)
TRANS = (0, 0, 0, 0)

px = [[TRANS] * 32 for _ in range(32)]

for y in range(4, 14):
    for x in range(8, 24):
        inset = 0
        if y >= 11: inset = y - 10
        if x < 8 + inset or x > 23 - inset:
            continue
        c = GOLD
        if y == 4:
            c = SHINE if x <= 12 else GOLD
        elif x >= 20:
            c = DGOLD
        px[y][x] = c

for cy, cx in ((8.0, 6.5), (8.0, 25.5)):
    for y in range(3, 14):
        for x in range(1, 31):
            d = math.hypot(x - cx, y - cy)
            if (3.2 <= d <= 4.6 and 1 <= x <= 7) or (3.2 <= d <= 4.6 and 24 <= x <= 30):
                px[y][x] = DGOLD

for y in range(14, 20):
    for x in range(13, 19):
        px[y][x] = DGOLD if x in (13, 18) else GOLD

for y in range(20, 24):
    for x in range(9, 23):
        px[y][x] = DGOLD if y == 23 or x in (9, 22) else GOLD

for y in range(6, 10):
    px[6 if y == 6 else y][10] = SHINE

# scale up
raw = b""
for by in range(H):
    raw += b"\x00"
    dy = by // S
    for bx in range(W):
        c = px[dy][bx // S]
        raw += struct.pack("4B", *c)

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))

# ICO wrapper (single 256 entry, PNG payload)
ico = (struct.pack("<HHH", 0, 1, 1)
       + struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
       + png)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.ico")
with open(out, "wb") as f:
    f.write(ico)
print("written", out, len(ico), "bytes")
