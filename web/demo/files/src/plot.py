"""Draws the season chart from stations.csv."""

import csv
from collections import defaultdict
from pathlib import Path

SOURCE = Path(__file__).parent.parent / "stations.csv"


def load(path: Path) -> dict[str, list[float]]:
    ranges: dict[str, list[float]] = defaultdict(list)
    with path.open() as handle:
        for row in csv.DictReader(handle):
            ranges[row["station"]].append(float(row["range_m"]))
    return ranges


def spark(values: list[float]) -> str:
    bars = "▁▂▃▄▅▆▇█"
    low, high = min(values), max(values)
    span = (high - low) or 1.0
    return "".join(bars[int((value - low) / span * (len(bars) - 1))] for value in values)


if __name__ == "__main__":
    for station, values in load(SOURCE).items():
        print(f"{station:<14} {spark(values)}  mean {sum(values) / len(values):.2f} m")
