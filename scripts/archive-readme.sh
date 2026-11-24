#!/usr/bin/env bash
# Prints the README as a release archive holds it. Its links into the repository would lead nowhere
# from an unpacked archive, so each gets its address on GitHub: a page for a document, the file
# itself for a picture. LICENSE and THIRD_PARTY.md are in the archive, and keep their links.
#
# The addresses name <ref>, a release's tag, so the README describes the binary beside it.
#
#   scripts/archive-readme.sh README.md <ref> > <archive folder>/README.md
set -euo pipefail

ref=${2:-main}
blob=https://github.com/jrnxf/okfs/blob/$ref
raw=https://github.com/jrnxf/okfs/raw/$ref
dirs='docs|skills|themes|web|ui|src'
sed -E \
  -e "s#(src|srcset)=\"(($dirs)/)#\1=\"$raw/\2#g" \
  -e "s#\]\((($dirs)/)#]($blob/\1#g" \
  -e "s#href=\"(($dirs)/)#href=\"$blob/\1#g" \
  "$1"
