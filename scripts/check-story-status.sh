#!/usr/bin/env bash
# Checks story file Status: headers against sprint-status.yaml (the source of truth).
# Exits non-zero if mismatches found. Run from repo root.

set -euo pipefail

YAML_FILE="_bmad-output/implementation-artifacts/sprint-status.yaml"
STORY_DIR="_bmad-output/implementation-artifacts"
mismatches=0

if [[ ! -f "$YAML_FILE" ]]; then
  echo "ERROR: $YAML_FILE not found" >&2
  exit 1
fi

# parse story entries from YAML, lines like "  1-1-monorepo-scaffold...: done"
# process substitution avoids the pipe-subshell trap where variable changes get lost
while IFS=: read -r key value; do
  slug=$(echo "$key" | xargs)
  yaml_status=$(echo "$value" | xargs)

  story_file="$STORY_DIR/$slug.md"
  [[ -f "$story_file" ]] || continue

  file_status=$(grep -m1 '^Status:' "$story_file" | sed 's/^Status:\s*//' | xargs)

  if [[ "$file_status" != "$yaml_status" ]]; then
    echo "MISMATCH: $slug, file says '$file_status', yaml says '$yaml_status'"
    mismatches=$((mismatches + 1))
  fi
done < <(grep -E '^\s+[0-9]+-[0-9]+-' "$YAML_FILE")

if [[ $mismatches -gt 0 ]]; then
  echo ""
  echo "$mismatches mismatch(es) found. Fix story file headers to match sprint-status.yaml."
  exit 1
else
  echo "All story file statuses match sprint-status.yaml."
fi
