"""Build compact static terrain tiles for GitHub Pages.

Each gzip file contains 128 x 128 RGB cells. RGB FFFFFF marks open sea.
The browser requests only tiles around the visible viewport.
"""

import gzip
import json
import math
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "docs"
TILE_CELLS = 128
TILE_BYTES = TILE_CELLS * TILE_CELLS * 3
SEA_TILE = b"\xff" * TILE_BYTES


def flush_band(factor, tile_y, buffers):
    folder = OUTPUT / "tiles" / str(factor)
    folder.mkdir(parents=True, exist_ok=True)
    sizes = []
    names = []
    for tile_x, buffer in enumerate(buffers):
        path = folder / f"{tile_y}-{tile_x}.bin.gz"
        if buffer == SEA_TILE:
            path.unlink(missing_ok=True)
            continue
        compressed = gzip.compress(buffer, compresslevel=6, mtime=0)
        path.write_bytes(compressed)
        sizes.append(len(compressed))
        names.append(f"{tile_y}-{tile_x}")
    return sizes, names


def main():
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / ".nojekyll").write_text("", encoding="utf-8")
    connection = sqlite3.connect(ROOT / "terrain.sqlite")
    try:
        metadata = {key: json.loads(value) for key, value in connection.execute("SELECT key,value FROM metadata")}
        metadata["tileCells"] = TILE_CELLS
        metadata["levelSizes"] = {}
        metadata["availableTiles"] = {}
        total_bytes = 0
        total_files = 0
        for factor in metadata["levels"]:
            row_count, max_chars = connection.execute(
                "SELECT COUNT(*), MAX(LENGTH(colors)) FROM rows WHERE factor=?", (factor,)
            ).fetchone()
            max_cols = max_chars // 6
            tile_columns = math.ceil(max_cols / TILE_CELLS)
            buffers = []
            current_band = -1
            level_bytes = 0
            available = []
            for row, colors in connection.execute(
                "SELECT row, colors FROM rows WHERE factor=? ORDER BY row", (factor,)
            ):
                if "ffffff" in colors:
                    raise ValueError("RGB FFFFFF is reserved for sea in static terrain tiles")
                tile_y = row // TILE_CELLS
                if tile_y != current_band:
                    if buffers:
                        sizes, names = flush_band(factor, current_band, buffers)
                        level_bytes += sum(sizes)
                        total_files += len(sizes)
                        available.extend(names)
                    buffers = [bytearray(b"\xff" * TILE_BYTES) for _ in range(tile_columns)]
                    current_band = tile_y
                packed = bytes.fromhex(colors.replace("------", "ffffff"))
                row_offset = (row % TILE_CELLS) * TILE_CELLS * 3
                for tile_x, buffer in enumerate(buffers):
                    chunk = packed[tile_x * TILE_CELLS * 3 : (tile_x + 1) * TILE_CELLS * 3]
                    buffer[row_offset : row_offset + len(chunk)] = chunk
            if buffers:
                sizes, names = flush_band(factor, current_band, buffers)
                level_bytes += sum(sizes)
                total_files += len(sizes)
                available.extend(names)
            metadata["levelSizes"][str(factor)] = {"rows": row_count, "columns": max_cols}
            metadata["availableTiles"][str(factor)] = available
            total_bytes += level_bytes
            print(f"factor {factor}: {level_bytes:,} bytes", flush=True)
        (OUTPUT / "meta.json").write_text(
            json.dumps(metadata, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        print(f"Static terrain: {total_files} files, {total_bytes:,} bytes")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
