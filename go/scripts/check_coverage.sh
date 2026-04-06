#!/usr/bin/env bash
set -euo pipefail

profile_path="${1:-coverage.out}"
threshold="${2:-70}"

total_line="$(go tool cover -func="$profile_path" | tail -n 1)"
total_pct="$(printf '%s\n' "$total_line" | awk '{print substr($3, 1, length($3)-1)}')"

awk -v actual="$total_pct" -v threshold="$threshold" 'BEGIN {
  if (actual + 0 < threshold + 0) {
    printf("coverage threshold failed: %.1f%% < %.1f%%\n", actual + 0, threshold + 0)
    exit 1
  }
  printf("coverage threshold passed: %.1f%% >= %.1f%%\n", actual + 0, threshold + 0)
}'
