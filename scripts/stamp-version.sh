#!/usr/bin/env bash
# Write a release version into Cargo.toml and Cargo.lock, so a tag needs no version-bump commit.
# Usage: scripts/stamp-version.sh <version>
# perl, not sed: the same edit on Linux, macOS and Windows. Cargo.toml's first version line is the
# package's; in Cargo.lock it is the one after okfs's name. \r? because a Windows checkout may
# turn the line endings into CRLF: without it the lock keeps its old version and `--locked` fails.
set -euo pipefail
export V=$1
perl -0pi -e 's/^version = ".*?"/version = "$ENV{V}"/m' Cargo.toml
perl -0pi -e 's/(\r?\nname = "okfs"\r?\nversion = )".*?"/$1"$ENV{V}"/' Cargo.lock
