#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Re-vendors the coalition + protocol source into a coalition-template checkout's
# app/ directory, so the template ships buildable code for Flux/Orbit.
#
# MAINTAINER tool — operators never run this. The coalition-template repo is the
# OUTPUT; THIS repo is the source of truth. Run after changing coalition/protocol
# to refresh the template, then commit the template.
#
#   operator/tools/vendor-template.sh <path-to-coalition-template>
# ─────────────────────────────────────────────────────────────────────────────
set -e
DEST=${1:?"usage: $0 <path-to-coalition-template>"}
[ -d "$DEST" ] || { echo "error: template path '$DEST' not found"; exit 1; }
SRC=$(cd "$(dirname "$0")/.." && pwd)   # operator repo root (this script lives in operator/tools)

copy_pkg() {          # $1 = protocol|coalition
  name=$1
  rm -rf "$DEST/app/$name"
  mkdir -p "$DEST/app/$name/src"
  for meta in package.json package-lock.json tsconfig.json; do
    [ -f "$SRC/$name/$meta" ] && cp "$SRC/$name/$meta" "$DEST/app/$name/"
  done
  for f in "$SRC/$name/src/"*.ts; do
    case "$f" in *.test.ts) continue ;; esac   # drop tests from the runtime image
    cp "$f" "$DEST/app/$name/src/"
  done
}

copy_pkg protocol
copy_pkg coalition

# Provenance: record the exact operator commit this was vendored from.
( cd "$SRC" && git rev-parse HEAD 2>/dev/null ) > "$DEST/app/VENDORED_FROM" || true
echo "Vendored protocol + coalition -> $DEST/app"
echo "  from operator commit: $(cat "$DEST/app/VENDORED_FROM" 2>/dev/null || echo unknown)"
echo "  coalition version:    $(node -e 'process.stdout.write(require("'"$SRC"'/coalition/package.json").version)' 2>/dev/null)"
