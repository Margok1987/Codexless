#!/bin/sh
set -eu

ACTION=${1:-}
ARCHIVE=${2:-}
DESTINATION=${3:-}

case "$ACTION" in
  list)
    [ -n "$ARCHIVE" ] || { echo "archive is required" >&2; exit 2; }
    LC_ALL=C /usr/bin/tar -tvzf "$ARCHIVE"
    ;;
  names)
    [ -n "$ARCHIVE" ] || { echo "archive is required" >&2; exit 2; }
    LC_ALL=C /usr/bin/tar -tzf "$ARCHIVE"
    ;;
  extract)
    [ -n "$ARCHIVE" ] || { echo "archive is required" >&2; exit 2; }
    [ -n "$DESTINATION" ] || { echo "destination is required" >&2; exit 2; }
    [ -d "$DESTINATION" ] || { echo "destination must already exist" >&2; exit 2; }
    # Caller must validate list/names first. --no-same-owner avoids restoring archive ownership.
    LC_ALL=C /usr/bin/tar -xzf "$ARCHIVE" -C "$DESTINATION" --no-same-owner
    ;;
  *)
    echo "usage: bootstrap-archive.sh <list|names|extract> <archive> [destination]" >&2
    exit 2
    ;;
esac
