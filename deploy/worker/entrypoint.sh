#!/bin/sh
set -eu

if [ "${BOSS_VIEWER_ENABLED:-false}" != "true" ]; then
  exec node --import tsx apps/browser-worker/src/index.ts
fi

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  # Close Chromium and release its persistent-profile lock before stopping X11.
  if [ -n "${worker_pid:-}" ] && kill -0 "$worker_pid" 2>/dev/null; then
    kill -TERM "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  for pid in "${nginx_pid:-}" "${websockify_pid:-}" "${vnc_pid:-}" "${xvfb_pid:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${worker_pid:-}" "${nginx_pid:-}" "${websockify_pid:-}" "${vnc_pid:-}" "${xvfb_pid:-}"; do
    if [ -n "$pid" ]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi
Xvfb :99 -screen 0 "${XVFB_SCREEN:-1440x900x24}" -nolisten tcp &
xvfb_pid=$!

display_ready=false
attempt=0
while [ "$attempt" -lt 100 ]; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    display_ready=true
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "Xvfb exited before display :99 became ready" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$display_ready" != "true" ]; then
  echo "Timed out waiting for Xvfb display :99" >&2
  exit 1
fi

x11vnc -display :99 -localhost -forever -shared -nopw -xkb &
vnc_pid=$!
websockify --web /usr/share/novnc 127.0.0.1:6081 127.0.0.1:5900 &
websockify_pid=$!
nginx -g 'daemon off;' &
nginx_pid=$!

node --import tsx apps/browser-worker/src/index.ts &
worker_pid=$!
wait "$worker_pid"
