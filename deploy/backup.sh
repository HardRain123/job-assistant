#!/bin/sh
set -eu

: "${APP_URL:=http://127.0.0.1:3000}"
if [ -z "${APP_PASSWORD:-}" ]; then
  printf 'Workbench password: ' >&2
  stty -echo </dev/tty
  IFS= read -r APP_PASSWORD </dev/tty
  stty echo </dev/tty
  printf '\n' >&2
fi
: "${APP_PASSWORD:?Workbench password is required.}"
command -v jq >/dev/null 2>&1 || { printf 'jq is required to encode the login request.\n' >&2; exit 1; }

umask 077
output_dir=${BACKUP_DIR:-./backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$output_dir"
temporary="$output_dir/.job-assistant-$timestamp.sqlite.part"
target="$output_dir/job-assistant-$timestamp.sqlite"
cookie="$output_dir/.job-assistant-$timestamp-$$.cookie"

cleanup() { rm -f "$temporary" "$cookie"; }
trap cleanup EXIT HUP INT TERM

printf '%s' "$APP_PASSWORD" | jq -Rsa '{password:.}' | curl --fail --show-error --silent \
  --request POST --header 'Content-Type: application/json' \
  --data-binary @- --cookie-jar "$cookie" --output /dev/null \
  "$APP_URL/api/login"
unset APP_PASSWORD
curl --fail --show-error --silent \
  --request POST \
  --cookie "$cookie" \
  --output "$temporary" \
  "$APP_URL/api/backup"

mv "$temporary" "$target"
rm -f "$cookie"
trap - EXIT HUP INT TERM
printf 'Consistent SQLite backup written to %s\n' "$target"
