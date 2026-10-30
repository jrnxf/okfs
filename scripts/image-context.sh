#!/usr/bin/env bash
# Lays out the Docker build context from a release's archives: <context>/linux-amd64/okfs and
# <context>/linux-arm64/okfs, where the Dockerfile looks for them.
#
#   scripts/image-context.sh <assets folder> <version> <context folder>
set -euo pipefail

assets=$1 version=$2 context=$3
for pair in amd64:x86_64 arm64:aarch64; do
  arch=${pair%%:*}
  target=${pair##*:}-unknown-linux-musl
  mkdir -p "$context/linux-$arch"
  tar -xzf "$assets/okfs-$version-$target.tar.gz" -O "okfs-$version-$target/okfs" > "$context/linux-$arch/okfs"
  chmod 0755 "$context/linux-$arch/okfs"
done
ls -l "$context"/*
