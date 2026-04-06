#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <luacov-report-file> <minimum-percent>" >&2
  exit 1
fi

report_file="$1"
minimum="$2"

if [[ ! -f "$report_file" ]]; then
  echo "coverage report not found: $report_file" >&2
  exit 1
fi

total_line="$(grep '^Total' "$report_file" | tail -n 1 || true)"
if [[ -z "$total_line" ]]; then
  echo "could not find Total line in $report_file" >&2
  exit 1
fi

coverage="$(awk '/^Total/ { print $(NF) }' "$report_file" | tail -n 1 | tr -d '%')"
if [[ -z "$coverage" ]]; then
  echo "could not parse coverage percentage from $report_file" >&2
  exit 1
fi

awk -v actual="$coverage" -v minimum="$minimum" '
BEGIN {
  if ((actual + 0) < (minimum + 0)) {
    printf("Lua coverage %.2f%% is below required %.2f%%\n", actual + 0, minimum + 0) > "/dev/stderr"
    exit 1
  }
  printf("Lua coverage %.2f%% meets required %.2f%%\n", actual + 0, minimum + 0)
}
'
