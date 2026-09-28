"""Sample lineage.trade map imagery into a simplified diamond terrain grid.

Usage: python build_terrain_grid.py OVERVIEW.webp TILE_MANIFEST.json
The source images are inputs only. The generated grid contains averaged colors.
"""

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

from PIL import Image
import requests


ROOT = Path(__file__).resolve().parent
HALF_WIDTH = 2
HALF_HEIGHT = 1
ROW_HEIGHT = 1
COLUMN_WIDTH = 4
SOURCE_SCALE = 8
TILE_SIZE_IN_OVERVIEW = 121
TILE_OFFSET = (-4, -3)
TILE_BASE = "https://www.lineage.trade/map-tiles/world/full/world-20260803-atlas-pages-v3"


def fine_tile(zoom: int, x: int, y: int):
    url = f"{TILE_BASE}/{zoom}/{x}/{y}.webp"
    try:
        response = requests.get(url, timeout=25)
        if response.status_code in (401, 403, 404):
            return None
        response.raise_for_status()
        return x, y, Image.open(BytesIO(response.content)).convert("RGB")
    except (requests.RequestException, OSError) as error:
        raise RuntimeError(f"Could not read terrain tile {url}: {error}") from error


def source_image(overview_path: Path, manifest_path: Path):
    overview = Image.open(overview_path).convert("RGB")
    image = overview.resize(
        (overview.width * SOURCE_SCALE, overview.height * SOURCE_SCALE),
        Image.Resampling.BICUBIC,
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for asset in manifest["assets"]:
        match = re.search(r"/4/(\d+)/(\d+)\.webp$", asset["url"])
        if not match:
            continue
        tile_x, tile_y = map(int, match.groups())
        tile = Image.open(asset["path"]).convert("RGB")
        tile = tile.resize((TILE_SIZE_IN_OVERVIEW * SOURCE_SCALE,) * 2, Image.Resampling.LANCZOS)
        image.paste(
            tile,
            (
                (tile_x * TILE_SIZE_IN_OVERVIEW + TILE_OFFSET[0]) * SOURCE_SCALE,
                (tile_y * TILE_SIZE_IN_OVERVIEW + TILE_OFFSET[1]) * SOURCE_SCALE,
            ),
        )
    # Zoom 5 tiles carry real additional terrain detail. The atlas overview is
    # used only where the public tile pyramid has no matching tile.
    with ThreadPoolExecutor(max_workers=12) as pool:
        jobs = [pool.submit(fine_tile, 5, x, y) for y in range(11) for x in range(18)]
        fine_tiles = [job.result() for job in as_completed(jobs)]
    fine_count = 0
    available_zoom5 = []
    for tile_result in fine_tiles:
        if tile_result is None:
            continue
        x, y, tile = tile_result
        available_zoom5.append((x, y))
        tile = tile.resize((TILE_SIZE_IN_OVERVIEW * SOURCE_SCALE // 2,) * 2, Image.Resampling.LANCZOS)
        image.paste(
            tile,
            (
                x * TILE_SIZE_IN_OVERVIEW * SOURCE_SCALE // 2 + TILE_OFFSET[0] * SOURCE_SCALE,
                y * TILE_SIZE_IN_OVERVIEW * SOURCE_SCALE // 2 + TILE_OFFSET[1] * SOURCE_SCALE,
            ),
        )
        fine_count += 1
    print(f"Loaded {fine_count} zoom-5 terrain tiles")
    # Each available zoom-5 tile has four possible zoom-6 children. This
    # bounds requests to the mapped area and avoids filling gaps by upscaling.
    with ThreadPoolExecutor(max_workers=12) as pool:
        jobs = [
            pool.submit(fine_tile, 6, x * 2 + dx, y * 2 + dy)
            for x, y in available_zoom5
            for dy in (0, 1)
            for dx in (0, 1)
        ]
        finer_tiles = [job.result() for job in as_completed(jobs)]
    finer_count = 0
    for tile_result in finer_tiles:
        if tile_result is None:
            continue
        x, y, tile = tile_result
        tile = tile.resize((TILE_SIZE_IN_OVERVIEW * SOURCE_SCALE // 4,) * 2, Image.Resampling.LANCZOS)
        image.paste(
            tile,
            (
                x * TILE_SIZE_IN_OVERVIEW * SOURCE_SCALE // 4 + TILE_OFFSET[0] * SOURCE_SCALE,
                y * TILE_SIZE_IN_OVERVIEW * SOURCE_SCALE // 4 + TILE_OFFSET[1] * SOURCE_SCALE,
            ),
        )
        finer_count += 1
    print(f"Loaded {finer_count} zoom-6 terrain tiles")
    return image, image.size


def diamond_pixels(image: Image.Image, cx: int, cy: int):
    pixels = image.load()
    half_width, half_height = HALF_WIDTH, HALF_HEIGHT
    for y in range(max(0, cy - half_height), min(image.height, cy + half_height + 1)):
        for x in range(max(0, cx - half_width), min(image.width, cx + half_width + 1)):
            if abs(x + 0.5 - cx) / half_width + abs(y + 0.5 - cy) / half_height <= 1:
                yield pixels[x, y]


def is_deep_sea(pixel):
    r, g, b = pixel
    return r < 22 and 34 <= g < 58 and 60 <= b < 95


def build_grid(image: Image.Image, size):
    rows = []
    land_cells = 0
    width, height = size
    for row, cy in enumerate(range(0, height + ROW_HEIGHT, ROW_HEIGHT)):
        start_x = (row % 2) * HALF_WIDTH
        colors = []
        for cx in range(start_x, width + HALF_WIDTH, COLUMN_WIDTH):
            samples = list(diamond_pixels(image, cx, cy))
            if not samples or sum(map(is_deep_sea, samples)) / len(samples) >= 0.75:
                colors.append("------")
                continue
            rgb = tuple(round(sum(pixel[channel] for pixel in samples) / len(samples)) for channel in range(3))
            colors.append("".join(f"{channel:02x}" for channel in rgb))
            land_cells += 1
        rows.append("".join(colors))
    return rows, land_cells


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python build_terrain_grid.py OVERVIEW.webp TILE_MANIFEST.json")
    source, size = source_image(Path(sys.argv[1]), Path(sys.argv[2]))
    rows, land_cells = build_grid(source, size)
    payload = {
        "format": "rows contain six-character RGB colors; ------ means deep sea",
        "coordinateSystem": "source overview image pixels x8",
        "sourceScale": SOURCE_SCALE,
        "width": size[0],
        "height": size[1],
        "halfWidth": HALF_WIDTH,
        "halfHeight": HALF_HEIGHT,
        "rowHeight": ROW_HEIGHT,
        "columnWidth": COLUMN_WIDTH,
        "rows": rows,
    }
    payload["source"] = "https://www.lineage.trade/market?mode=map"
    payload["detailTileZoom"] = 6
    (ROOT / "terrain-grid.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    (ROOT / "terrain-grid-data.js").write_text(
        "// Generated from terrain-grid.json for direct local-file loading.\n"
        "const TERRAIN_GRID = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    # Preview images are generated from the numeric level-of-detail data.
    print(f"Generated {len(rows)} rows, {land_cells} colored cells")


if __name__ == "__main__":
    main()
