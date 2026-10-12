#!/usr/bin/env bash
# Shoots the 16 pictures in docs/screenshots/ again: the hero, the grid and the palette in light
# and dark, and the five themes in light and dark.
#
#   scripts/shoot-readme.sh DEMO_DIR [OUT_DIR]
#
# DEMO_DIR is the folder to serve. The pictures were made from a small folder called "tidewater".
# Outside the repository it holds, at its top level: field-notes.md, gauges.json, harbor-at-dawn.jpg,
# harbor-bell.wav, README.md, ridge-line.jpg, stations.csv, survey-2026.zip and tide-table.txt, and
# the folders data/ (two files), photos/ (eight pictures, 01-low-tide.jpg to 08-last-light.jpg,
# with 05-headland.jpg among them) and src/ (tide.rs, plot.py, Makefile.toml). The script moves the
# cursor to those names, so a folder without them fails with "cursor never reached". File ages show
# as "2d" or "Jul 1", so the pictures differ a little with the day they are shot.
# OUT_DIR defaults to docs/screenshots.
#
# Needs a release build at target/release/okfs (or OKFS_BIN), `chrome-devtools-axi` on the PATH, and
# nix for ImageMagick, libwebp and pngquant (used only when they are not already on the PATH).
# The server listens on 127.0.0.1:$PORT (default 18791) and is stopped by process id on exit.
set -euo pipefail

if ! command -v magick >/dev/null || ! command -v cwebp >/dev/null || ! command -v pngquant >/dev/null; then
  exec nix shell nixpkgs#imagemagick nixpkgs#libwebp nixpkgs#pngquant -c "$0" "$@"
fi

root=$(cd "$(dirname "$0")/.." && pwd)
demo=${1:?usage: scripts/shoot-readme.sh DEMO_DIR [OUT_DIR]}
out=${2:-$root/docs/screenshots}
bin=${OKFS_BIN:-$root/target/release/okfs}
port=${PORT:-18791}
base=http://127.0.0.1:$port
work=$(mktemp -d)
export CHROME_DEVTOOLS_AXI_SESSION=okfs-readme-shots
cdp=chrome-devtools-axi

"$bin" "$demo" --port "$port" >"$work/server.log" 2>&1 &
server=$!
cleanup() {
  kill "$server" 2>/dev/null || true
  "$cdp" stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
until curl -sf -o /dev/null "$base/"; do sleep 0.2; done
mkdir -p "$out"

# Two device pixels per CSS pixel. The hero is 1280x800; every other picture is 960x640.
viewport() { # WxH scheme
  # The page remembers its view (list or grid) per browser: start every picture from a clean one.
  "$cdp" open "$base/" >/dev/null 2>&1 || true
  "$cdp" eval "() => { localStorage.clear(); return 0; }" >/dev/null
  "$cdp" emulate --viewport "${1}x2" --color-scheme "$2" >/dev/null
}

# The name of the row under the cursor in the list or the grid.
cursor() {
  "$cdp" eval "() => (document.querySelector('[data-i][aria-selected=true]')?.innerText || '').trim()" |
    sed -n 's/^result: "\(.*\)"$/\1/p'
}

# Moves the cursor with KEY until it is on the file NAME. Fails if it never gets there.
move_to() { # name key
  local n
  for n in $(seq 0 30); do
    case "$(cursor)" in *"$1"*) return 0 ;; esac
    "$cdp" press "$2" >/dev/null
  done
  echo "cursor never reached $1" >&2
  return 1
}

settle() {
  "$cdp" eval "() => document.fonts.ready.then(() => { document.activeElement?.blur?.(); return 0; })" >/dev/null
  "$cdp" wait 900 >/dev/null
}

# Cuts the rounded window corners and draws the 1px edge, as the first set was made.
frame() { # raw.png scheme out.png
  local w h edge
  w=$(magick identify -format %w "$1")
  h=$(magick identify -format %h "$1")
  if [ "$2" = dark ]; then edge='#404040'; else edge='#c4c4c4'; fi
  magick "$1" -alpha set \
    \( -size "${w}x${h}" xc:black -fill white -draw "roundrectangle 0,0,$((w - 1)),$((h - 1)),24,24" \) \
    -compose CopyOpacity -composite \
    -fill none -stroke "$edge" -strokewidth 2 \
    -draw "roundrectangle 1,1,$((w - 2)),$((h - 2)),23,23" "$3"
}

shoot() { # name scheme size url setup-function
  local name=$1 scheme=$2 raw=$work/$1.png
  viewport "$3" "$scheme"
  "$cdp" open "$base$4" >/dev/null 2>&1
  "$cdp" wait 800 >/dev/null
  "$5"
  settle
  "$cdp" screenshot "$raw" >/dev/null
  frame "$raw" "$scheme" "$work/$name.framed.png"
  case $name in
    theme-*) pngquant --force --quality 80-100 --output "$out/$name.png" "$work/$name.framed.png" ;;
    *) cwebp -quiet -q 90 -alpha_q 100 "$work/$name.framed.png" -o "$out/$name.webp" ;;
  esac
  echo "$name"
}

hero() { move_to harbor-at-dawn.jpg j; }
grid() { "$cdp" press g >/dev/null; move_to 05-headland.jpg l; }
palette() {
  move_to harbor-at-dawn.jpg j
  "$cdp" press Control+k >/dev/null
  "$cdp" wait 300 >/dev/null
  "$cdp" type tide >/dev/null
  "$cdp" wait 400 >/dev/null
}
notes() { move_to field-notes.md j; }

for scheme in light dark; do
  q="scheme=$scheme"
  shoot "hero-$scheme" "$scheme" 1280x800 "/?theme=default&$q" hero
  shoot "grid-$scheme" "$scheme" 960x640 "/photos/?theme=default&$q" grid
  shoot "palette-$scheme" "$scheme" 960x640 "/?theme=default&$q" palette
  for theme in default paper terminal fjord riso; do
    shoot "theme-$theme-$scheme" "$scheme" 960x640 "/?theme=$theme&$q" notes
  done
done
