"""Build coarser numeric diamond grids from terrain-grid.json.

Each cell averages the fine-grid cells whose centers fall inside its diamond.
The browser chooses a level according to zoom and draws only visible cells.
"""

import json
from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent
FACTORS = (2, 4, 8, 16, 32)


def cell_color(rows, row, col):
    if row < 0 or row >= len(rows) or col < 0:
        return None
    start = col * 6
    if start + 6 > len(rows[row]):
        return None
    return rows[row][start : start + 6]


def aggregate(rows, width, height, base_factor, factor):
    half_width = 2 * factor
    result = []
    for coarse_row, cy in enumerate(range(0, height + factor, factor)):
        first_x = (coarse_row % 2) * half_width
        colors = []
        for cx in range(first_x, width + half_width, 4 * factor):
            counts = [0, 0, 0, 0, 0]  # total, land, red, green, blue
            first_row = max(0, (cy - factor + base_factor - 1) // base_factor)
            last_row = min(len(rows) - 1, (cy + factor) // base_factor)
            for fine_row in range(first_row, last_row + 1):
                dy = abs(fine_row * base_factor - cy)
                reach = half_width * (factor - dy) / factor
                if reach < 0:
                    continue
                first_fine_x = (fine_row % 2) * 2 * base_factor
                column_width = 4 * base_factor
                col_min = max(0, int((cx - reach - first_fine_x) // column_width))
                col_max = int((cx + reach - first_fine_x) // column_width) + 1
                for fine_col in range(col_min, col_max + 1):
                    x = first_fine_x + fine_col * column_width
                    if abs(x - cx) > reach:
                        continue
                    color = cell_color(rows, fine_row, fine_col)
                    if color is None:
                        continue
                    counts[0] += 1
                    if color == "------":
                        continue
                    counts[1] += 1
                    for channel in range(3):
                        counts[channel + 2] += int(color[channel * 2 : channel * 2 + 2], 16)
            # Open sea remains unfilled. Shore cells use the local non-sea color.
            land = counts[1]
            if not counts[0] or not land or (counts[0] - land) / counts[0] >= 0.75:
                colors.append("------")
            else:
                colors.append("".join(f"{round(value / land):02x}" for value in counts[2:]))
        result.append("".join(colors))
    return result


def write_svg(rows, width, height, factor):
    half_width = 2 * factor
    half_height = factor
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {width} {height}" width="{width}" height="{height}">',
        '<title>天堂大陸菱形格地形圖</title>',
        f'<path fill="#0a2c48" d="M0 0H{width}V{height}H0Z"/>',
        '<g stroke="#18201b" stroke-opacity=".22" stroke-width=".3">',
    ]
    for row, colors in enumerate(rows):
        cy = row * factor
        first_x = (row % 2) * half_width
        for col in range(len(colors) // 6):
            color = colors[col * 6 : col * 6 + 6]
            if color == "------":
                continue
            cx = first_x + col * 4 * factor
            parts.append(
                f'<path fill="#{color}" d="M{cx} {cy-half_height}'
                f'L{cx+half_width} {cy}L{cx} {cy+half_height}'
                f'L{cx-half_width} {cy}Z"/>'
            )
    parts += ["</g>", "</svg>"]
    (ROOT / "terrain-vector-overview.svg").write_text("\n".join(parts) + "\n", encoding="utf-8")


def write_preview(rows, width, height, factor, crop, output):
    left, top, right, bottom = crop
    scale = 0.5
    image = Image.new("RGB", (round((right-left)*scale), round((bottom-top)*scale)), (10, 44, 72))
    draw = ImageDraw.Draw(image)
    for row, colors in enumerate(rows):
        cy = row * factor
        if cy + factor < top or cy - factor > bottom:
            continue
        first_x = (row % 2) * 2 * factor
        col_start = max(0, int((left - first_x - 2*factor) // (4*factor)))
        col_end = min(len(colors)//6-1, int((right - first_x + 2*factor) // (4*factor)) + 1)
        for col in range(col_start, col_end + 1):
            color = colors[col*6:col*6+6]
            if color == "------":
                continue
            cx = first_x + col*4*factor
            vertices = [
                ((cx-left)*scale,(cy-factor-top)*scale),
                ((cx+2*factor-left)*scale,(cy-top)*scale),
                ((cx-left)*scale,(cy+factor-top)*scale),
                ((cx-2*factor-left)*scale,(cy-top)*scale),
            ]
            draw.polygon(vertices,fill="#"+color)
    image.save(ROOT / output,optimize=True)


def main():
    grid = json.loads((ROOT / "terrain-grid.json").read_text(encoding="utf-8"))
    levels = []
    source_rows = grid["rows"]
    source_factor = 1
    for factor in FACTORS:
        rows = aggregate(source_rows, grid["width"], grid["height"], source_factor, factor)
        levels.append({"factor": factor, "rows": rows})
        print(f"factor {factor}: {len(rows)} rows")
        source_rows, source_factor = rows, factor
    payload = {"sourceScale": grid["sourceScale"], "levels": levels}
    (ROOT / "terrain-lod.json").write_text(
        json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    (ROOT / "terrain-lod-data.js").write_text(
        "// Generated from the numeric terrain-grid.json.\n"
        "const TERRAIN_LOD = " + json.dumps(payload, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    write_svg(levels[3]["rows"], grid["width"], grid["height"], 16)
    write_preview(levels[1]["rows"],grid["width"],grid["height"],4,
                  (0,0,grid["width"],grid["height"]),"terrain-preview.png")
    write_preview(levels[0]["rows"],grid["width"],grid["height"],2,
                  (2500,1000,4100,2240),"dragon-valley-preview.png")


if __name__ == "__main__":
    main()
