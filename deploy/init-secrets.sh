#!/bin/sh
set -eu

secrets_dir=${SECRETS_DIR:-.secrets}
umask 077
mkdir -p "$secrets_dir"

random_value() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  elif command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"
  else
    echo "openssl or node is required to generate secrets" >&2
    exit 1
  fi
}

write_if_missing() {
  name=$1
  value=$2
  target="$secrets_dir/$name"
  if [ -e "$target" ]; then
    printf '%s already exists; left unchanged.\n' "$target"
    return
  fi
  printf '%s' "$value" > "$target"
  chmod 600 "$target"
  printf 'Created %s\n' "$target"
}

write_if_missing internal_token "$(random_value)"
write_if_missing app_key "$(random_value)"

if [ -e "$secrets_dir/app_password" ]; then
  printf '%s already exists; left unchanged.\n' "$secrets_dir/app_password"
elif [ "${APP_PASSWORD+x}" = x ]; then
  write_if_missing app_password "$APP_PASSWORD"
else
  generated_password=$(random_value)
  write_if_missing app_password "$generated_password"
  printf 'Store this generated application password now: %s\n' "$generated_password"
fi
