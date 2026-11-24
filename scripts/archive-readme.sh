#!/usr/bin/env bash
# Prints the README as a release archive holds it. Its links into the repository would lead nowhere
# from an unpacked archive, so each gets its address on GitHub: a page for a document, the file
# itself for a picture. LICENSE and THIRD_PARTY.md are in the archive, and keep their links.
#
#   scripts/archive-readme.sh README.md > <archive folder>/README.md
set -euo pipefail

blob=https://github.com/jrnxf/okfs/blob/main
raw=https://github.com/jrnxf/okfs/raw/main
dirs='docs|skills|themes|web|ui|src'
sed -E \
  -e "s#(src|srcset)=\"(($dirs)/)#\1=\"$raw/\2#g" \
  -e "s#\]\((($dirs)/)#]($blob/\1#g" \
  -e "s#href=\"(($dirs)/)#href=\"$blob/\1#g" \
  "$1"
