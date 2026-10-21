#!/usr/bin/env bash
# Renders the chart tiles again from the latest survey, then checks that every zoom level is whole.
set -euo pipefail

survey=${1:-surveys/latest.geojson}
out=maps/tiles

echo "rendering $survey into $out"
cargo run --release -p tile-render -- --survey "$survey" --out "$out" --max-zoom 8

for z in $(seq 0 8); do
  want=$(( (1 << z) * (1 << z) ))
  have=$(find "$out/$z" -name '*.png' | wc -l)
  if [ "$have" -ne "$want" ]; then
    echo "zoom $z has $have tiles, wants $want" >&2
    exit 1
  fi
done
echo "all tiles in place"
