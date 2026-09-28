"""Serve the map and only the numeric diamond cells requested by the viewport.

Run: python terrain_server.py
Open: http://127.0.0.1:8765/
"""

import argparse
import gzip
import json
import math
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "terrain.sqlite"
MAX_CELLS = 500_000


def load_metadata():
    with sqlite3.connect(DATABASE) as connection:
        return {key: json.loads(value) for key, value in connection.execute("SELECT key, value FROM metadata")}


GRID = load_metadata()
LEVELS = set(GRID["levels"])


def terrain_slice(query):
    try:
        factor = int(query["factor"][0])
        bounds = [float(query[name][0]) for name in ("left", "top", "right", "bottom")]
    except (KeyError, IndexError, ValueError) as error:
        raise ValueError("factor, left, top, right and bottom are required") from error
    if factor not in LEVELS or not all(math.isfinite(value) for value in bounds):
        raise ValueError("Invalid factor or bounds")
    left, top, right, bottom = bounds
    if right <= left or bottom <= top:
        raise ValueError("Bounds must have positive width and height")
    width, height = GRID["width"], GRID["height"]
    if right - left > width * 4 or bottom - top > height * 4:
        raise ValueError("Requested area is too large")
    half_width = GRID["halfWidth"] * factor
    half_height = GRID["halfHeight"] * factor
    row_height = GRID["rowHeight"] * factor
    column_width = GRID["columnWidth"] * factor
    first_row = max(0, math.floor((top - half_height) / row_height))
    last_row = min(math.ceil(height / row_height), math.ceil((bottom + half_height) / row_height))
    result = []
    cell_count = 0
    with sqlite3.connect(DATABASE) as connection:
        connection.execute("PRAGMA cache_size=-2048")
        row_data = connection.execute(
            "SELECT row, colors FROM rows WHERE factor=? AND row BETWEEN ? AND ? ORDER BY row",
            (factor, first_row, last_row),
        )
        for row, colors in row_data:
            first_x = (row % 2) * half_width
            first_col = max(0, math.floor((left - half_width - first_x) / column_width))
            last_col = min(len(colors) // 6 - 1, math.ceil((right + half_width - first_x) / column_width))
            if last_col < first_col:
                continue
            cell_count += last_col - first_col + 1
            if cell_count > MAX_CELLS:
                raise ValueError("Requested area exceeds the cell limit; zoom in or use a coarser factor")
            result.append([row, first_col, colors[first_col * 6 : (last_col + 1) * 6]])
    return {"factor": factor, "bounds": bounds, "rows": result, "cells": cell_count}


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, status, body, content_type, compress=False):
        if compress and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, compresslevel=5)
            encoding = "gzip"
        else:
            encoding = None
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path in ("/", "/lineage-grid-map.html"):
            body = (ROOT / "lineage-grid-map.html").read_bytes()
            self.send_bytes(200, body, "text/html; charset=utf-8")
            return
        if parsed.path == "/api/meta":
            meta = {
                "width": GRID["width"],
                "height": GRID["height"],
                "halfWidth": GRID["halfWidth"],
                "halfHeight": GRID["halfHeight"],
                "rowHeight": GRID["rowHeight"],
                "columnWidth": GRID["columnWidth"],
                "levels": sorted(LEVELS),
            }
            self.send_bytes(200, json.dumps(meta, separators=(",", ":")).encode(), "application/json; charset=utf-8")
            return
        if parsed.path == "/api/terrain":
            try:
                payload = terrain_slice(parse_qs(parsed.query))
            except ValueError as error:
                self.send_bytes(400, json.dumps({"error": str(error)}).encode(), "application/json; charset=utf-8")
                return
            self.send_bytes(200, json.dumps(payload, separators=(",", ":")).encode(), "application/json; charset=utf-8", compress=True)
            return
        self.send_bytes(404, b"Not found", "text/plain; charset=utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Map API ready at http://127.0.0.1:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
