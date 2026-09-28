"""Pack numeric terrain rows into a SQLite file for viewport reads."""

import json
import os
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "terrain.sqlite"


def main():
    temp = ROOT / "terrain.sqlite.tmp"
    if temp.exists():
        temp.unlink()
    connection = sqlite3.connect(temp)
    try:
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute("CREATE TABLE rows (factor INTEGER NOT NULL, row INTEGER NOT NULL, colors TEXT NOT NULL, PRIMARY KEY (factor, row)) WITHOUT ROWID")
        connection.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
        grid = json.loads((ROOT / "terrain-grid.json").read_text(encoding="utf-8"))
        lod = json.loads((ROOT / "terrain-lod.json").read_text(encoding="utf-8"))
        if grid["sourceScale"] != lod["sourceScale"]:
            raise ValueError("Grid and LOD source scales differ")
        levels = [1] + [item["factor"] for item in lod["levels"]]
        metadata = {name: grid[name] for name in ("width", "height", "halfWidth", "halfHeight", "rowHeight", "columnWidth")}
        metadata["levels"] = levels
        connection.executemany("INSERT INTO metadata VALUES (?, ?)", ((key, json.dumps(value)) for key, value in metadata.items()))
        for factor, rows in [(1, grid["rows"])] + [(item["factor"], item["rows"]) for item in lod["levels"]]:
            connection.executemany("INSERT INTO rows VALUES (?, ?, ?)", ((factor, row, colors) for row, colors in enumerate(rows)))
            print(f"Indexed factor {factor}: {len(rows)} rows", flush=True)
        connection.commit()
    finally:
        connection.close()
    os.replace(temp, TARGET)
    print(f"Created {TARGET.name}: {TARGET.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
