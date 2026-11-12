#!/bin/sh
# Lint gate scoped to the thread's own changes: eslint on the .ts/.tsx files changed
# against the base branch (default origin/dev). A full-repo eslint run on a large repo
# needs a big Node heap — risky on a laptop — and fails on old problems the agent didn't
# cause. Usage (gate command, run in the worktree): sh <fleet>/scripts/lint-changed.sh [base]
set -eu
base="${1:-origin/dev}"
files=$(git diff --name-only --diff-filter=ACMR "$base"...HEAD -- '*.ts' '*.tsx' | while read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done)
if [ -z "$files" ]; then
  echo "lint: no changed .ts files"
  exit 0
fi
echo "lint: $(printf '%s\n' "$files" | wc -l | tr -d ' ') changed file(s)"
# shellcheck disable=SC2086
exec npx eslint --max-warnings=-1 $files
