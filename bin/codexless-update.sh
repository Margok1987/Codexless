#!/bin/sh
set -eu
INSTALL_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
BOOTSTRAP_RUN="$HOME/.config/codexless/bootstrap/run.mjs"
if [ ! -f "$BOOTSTRAP_RUN" ]; then
  echo "Codexless updater bootstrap is missing. Re-run the Codexless installer to repair it." >&2
  exit 1
fi
exec node "$BOOTSTRAP_RUN" update --install-dir "$INSTALL_DIR" "$@"
