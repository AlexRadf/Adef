#!/usr/bin/env bash
# Parse-check and test Sector-4 with a headless Godot.
#
#   GODOT=/path/to/godot ./tools/check.sh
#
# Exits non-zero if anything fails to compile or any assertion fails, so
# this is the thing to put in CI.
set -uo pipefail

GODOT="${GODOT:-godot}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v "$GODOT" >/dev/null 2>&1 && [ ! -x "$GODOT" ]; then
	echo "Sector-4: no Godot binary. Set GODOT=/path/to/godot" >&2
	exit 127
fi

echo "== importing (compiles every script and scene) =="
IMPORT_LOG="$("$GODOT" --headless --path "$HERE" --import 2>&1)"
if echo "$IMPORT_LOG" | grep -qiE "SCRIPT ERROR|Parse Error|Failed to load script"; then
	echo "$IMPORT_LOG" | grep -iE "SCRIPT ERROR|Parse Error|Failed to load script" | sort -u
	exit 1
fi
echo "   ok"

echo
echo "== headless tests =="
# The dummy renderer complains about meshes it cannot see; that is noise.
"$GODOT" --headless --path "$HERE" res://tests/TestRunner.tscn 2>&1 \
	| grep -vE "mesh_get_surface_count|Parameter \"m\" is null|ObjectDB instances leaked|^\s+at: cleanup"
exit "${PIPESTATUS[0]}"
