#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then exit 64; fi

posted=$1
live_is_baseline=$2
stable_count=$3
required_count=$4

case "$posted" in true|false) ;; *) exit 64 ;; esac
case "$live_is_baseline" in true|false) ;; *) exit 64 ;; esac
printf '%s' "$stable_count" | grep -Eq '^[0-9]+$' || exit 64
printf '%s' "$required_count" | grep -Eq '^[1-9][0-9]*$' || exit 64

if [ "$live_is_baseline" = true ]; then
  if [ $((stable_count + 1)) -ge "$required_count" ]; then
    printf 'complete\n'
  else
    printf 'observe\n'
  fi
elif [ "$posted" = true ]; then
  printf 'wait\n'
else
  printf 'post_once\n'
fi
