#!/bin/sh
set -eu
PLUNGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$PLUNGE_ROOT/runtime/node" "$PLUNGE_ROOT/launch.mjs" --open-browser "$@"
