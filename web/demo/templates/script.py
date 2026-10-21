"""Backfills the archive from the gauges' own memory after a network outage."""

import argparse
import csv
from datetime import date, timedelta
from pathlib import Path

from harbor.gauges import connect


def backfill(station: str, since: date, archive: Path) -> int:
    gauge = connect(station)
    written = 0
    day = since
    while day < date.today():
        target = archive / station / f"{day:%Y}" / f"{day:%m}" / f"{day:%Y-%m-%d}.csv"
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("w", newline="") as f:
                out = csv.writer(f)
                out.writerow(["time", "raw_cm", "height_m", "battery"])
                for reading in gauge.memory(day):
                    out.writerow([reading.time, reading.raw_cm, reading.height_m, reading.battery])
            written += 1
        day += timedelta(days=1)
    return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("station")
    parser.add_argument("--since", type=date.fromisoformat, required=True)
    parser.add_argument("--archive", type=Path, default=Path("archive"))
    args = parser.parse_args()
    print(f"wrote {backfill(args.station, args.since, args.archive)} days")
