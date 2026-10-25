#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Common Table cashier install: %s\n' "$1" >&2
  exit 1
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail 'This helper supports Linux desktops with systemd user services.'
fi
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  fail 'A running systemd user manager is required. Sign in to the cashier desktop session and retry.'
fi

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
env_file="$app_dir/.env"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
state_dir="${XDG_DATA_HOME:-$HOME/.local/share}/common-table-pos"
database_path="$state_dir/outlet.sqlite"
unit_file="$unit_dir/common-table-pos.service"
npm_bin="$(command -v npm || true)"
node_bin="$(command -v node || true)"

[[ -f "$env_file" ]] || fail "Missing $env_file. Copy the one-time terminal configuration from the manager portal first."
[[ -n "$node_bin" && -n "$npm_bin" ]] || fail 'Install Node.js 22+ and npm 10+ first.'
node_major="$("$node_bin" --version | sed 's/^v//' | cut -d. -f1)"
npm_major="$("$npm_bin" --version | cut -d. -f1)"
[[ "$node_major" -ge 22 ]] || fail 'Node.js 22 or newer is required.'
[[ "$npm_major" -ge 10 ]] || fail 'npm 10 or newer is required.'

# Escape paths for systemd's quoted-string syntax. Percent specifiers and newlines
# need separate handling and are deliberately rejected.
if [[ "$app_dir$env_file$state_dir$npm_bin" == *'%'* || "$app_dir$env_file$state_dir$npm_bin" == *$'\n'* ]]; then
  fail 'Install paths may not contain newlines or systemd specifier characters (%).'
fi
systemd_path_escape() {
  local escaped="$1"
  escaped="${escaped//\\/\\x5c}"
  escaped="${escaped// /\\x20}"
  escaped="${escaped//$'\t'/\\x09}"
  printf '%s' "$escaped"
}
escaped_app_dir="$(systemd_path_escape "$app_dir")"
escaped_env_file="$(systemd_path_escape "$env_file")"
escaped_state_dir="$(systemd_path_escape "$state_dir")"
quoted_npm_bin="$(printf '"%s"' "${npm_bin//\"/\\\"}")"

printf 'Building Common Table POS in %s\n' "$app_dir"
cd "$app_dir"
"$npm_bin" ci
"$npm_bin" run build

NODE_ENV=production "$node_bin" --env-file="$env_file" --input-type=module -e \
  "import('./apps/server/dist/config.js').then(({checkEdgeConfiguration,SYNC_CONFIG})=>{checkEdgeConfiguration();if(!SYNC_CONFIG.url||!SYNC_CONFIG.terminalKey)throw new Error('Terminal cloud sync is not configured. Enroll this laptop and copy its complete one-time configuration.');})" \
  || fail 'Outlet/Auth configuration is incomplete or terminal sync is not paired. See the error above.'

service_was_active=false
if systemctl --user is-active --quiet common-table-pos.service; then
  service_was_active=true
elif ! "$node_bin" --input-type=module -e "import net from 'node:net';const s=net.createServer();s.once('error',()=>process.exit(1));s.listen(3001,'127.0.0.1',()=>s.close(()=>process.exit(0)))"; then
  fail 'Port 3001 is already in use. Stop the other POS/dev server and retry.'
fi

install -d -m 700 "$unit_dir" "$state_dir"
env_tmp="$(mktemp "$app_dir/.env.XXXXXX")"
awk -v setting="POS_DATABASE_PATH=$database_path" '
  BEGIN { replaced = 0 }
  /^POS_DATABASE_PATH=/ {
    if (!replaced) print setting
    replaced = 1
    next
  }
  { print }
  END { if (!replaced) print setting }
' "$env_file" > "$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" "$env_file"
chmod 600 "$env_file"
cat > "$unit_file" <<EOF
[Unit]
Description=Common Table POS cashier edge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$escaped_app_dir
EnvironmentFile=$escaped_env_file
Environment=NODE_ENV=production
ExecStart=$quoted_npm_bin start
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$escaped_state_dir
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=default.target
EOF
chmod 600 "$unit_file"

systemctl --user daemon-reload
systemctl --user enable common-table-pos.service
if [[ "$service_was_active" == true ]]; then
  systemctl --user restart common-table-pos.service
else
  systemctl --user start common-table-pos.service
fi

for attempt in {1..20}; do
  if "$node_bin" --input-type=module -e "const r=await fetch('http://127.0.0.1:3001/api/ready').catch(()=>null);if(r?.ok)process.exit(0);process.exit(1)"; then
    printf 'Common Table POS is ready at http://localhost:3001/\n'
    printf 'Service controls: systemctl --user status|restart|stop common-table-pos.service\n'
    printf 'Logs: journalctl --user -u common-table-pos.service -f\n'
    exit 0
  fi
  sleep 1
done

systemctl --user status common-table-pos.service --no-pager >&2 || true
journalctl --user -u common-table-pos.service -n 40 --no-pager >&2 || true
fail 'The service did not become ready. Review its logs above; it remains enabled for diagnosis.'
