#!/usr/bin/env bash
# Deploy BillStack on the VPS: update code, rebuild the frontend, restart ONLY the BillStack API.
#
#   curl -fsSL https://raw.githubusercontent.com/Nemnidhi/toor-billstack/<branch>/scripts/deploy-vps.sh | BRANCH=<branch> bash
#
# Run as root (or as the app owner). Safe by design:
#   * works on one checkout only (default /home/billstack/apps/toor-billstack) and as that folder's owner
#   * the frontend is built into dist.new and swapped in only after a successful build
#   * only the billstack API/worker services are restarted - never MongoDB, the CRM or nginx config
#   * if the health check fails after the restart, the previous version is restored automatically
#
# Optional environment: APP_DIR=/path/to/toor-billstack  API_SERVICE=billstack-preview-api
#                       WORKER_SERVICE=billstack-preview-worker  PORT=5101  HEALTH_PATH=/api/health
set -euo pipefail

BRANCH="${BRANCH:-main}"
DEFAULT_APP_DIR="/home/billstack/apps/toor-billstack"
API_SERVICE="${API_SERVICE:-billstack-preview-api}"
WORKER_SERVICE="${WORKER_SERVICE:-billstack-preview-worker}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "Locating the BillStack checkout"
APP_DIR="${APP_DIR:-$DEFAULT_APP_DIR}"
[ -d "$APP_DIR/.git" ] && [ -d "$APP_DIR/frontend" ] && [ -d "$APP_DIR/backend" ] \
  || die "No BillStack checkout at $APP_DIR. Re-run with APP_DIR=/path/to/toor-billstack (the folder nginx serves frontend/dist from)."
APP_OWNER="$(stat -c %U "$APP_DIR")"
echo "App directory: $APP_DIR (owner: $APP_OWNER)"
# Earlier deploys run as root can leave root-owned build folders that the owner cannot replace.
if [ "$(id -u)" = 0 ]; then chown -R "$APP_OWNER":"$APP_OWNER" "$APP_DIR" 2>/dev/null || true; fi

# Run a command as the folder's owner so files never become root-owned.
run() {
  if [ "$(id -un)" = "$APP_OWNER" ]; then bash -c "$1"
  else su -s /bin/bash "$APP_OWNER" -c "$1"
  fi
}
in_app() { run "cd '$APP_DIR' && $1"; }

has_unit() { systemctl list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$1.service"; }
has_unit "$API_SERVICE" || die "systemd service '$API_SERVICE' not found. Set API_SERVICE=<name> (see: systemctl list-units | grep -i bill)."

ENV_PORT="${PORT:-$(grep -E '^PORT=' "$APP_DIR/backend/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r\"' || true)}"

# The port the API really listens on can differ from backend/.env (systemd may override it),
# so ask the running service: every listening port of its process tree, then the fallbacks.
service_ports() {
  local main frontier next kids f p pids
  main="$(systemctl show "$API_SERVICE" -p MainPID --value 2>/dev/null || true)"
  [ -n "$main" ] && [ "$main" != 0 ] || return 0
  pids="$main"; frontier="$main"
  while [ -n "$frontier" ]; do
    next=""
    for f in $frontier; do kids="$(ps -o pid= --ppid "$f" 2>/dev/null | tr -d ' ' | tr '\n' ' ')"; next="$next $kids"; done
    frontier="$(echo $next)"; pids="$pids $frontier"
  done
  for p in $pids; do ss -ltnpH 2>/dev/null | grep "pid=$p," | awk '{print $4}' | sed 's/.*://'; done
}
healthy() {
  local port
  for port in $(service_ports) $ENV_PORT 5101; do
    [ -n "$port" ] || continue
    if curl -fsS "http://127.0.0.1:${port}${HEALTH_PATH}" >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  return 1
}

say "Saving a rollback point"
PREV_SHA="$(in_app 'git rev-parse HEAD')"
echo "Current commit: $PREV_SHA"
if [ -n "$(in_app 'git status --porcelain --untracked-files=no')" ]; then
  in_app "git stash push -m 'pre-deploy $(date +%F-%H%M)' >/dev/null" && echo "Local edits on the server were stashed (git stash list)."
fi

say "Fetching $BRANCH"
in_app "git fetch -q origin '$BRANCH'"
in_app "git checkout -q -B deploy-live FETCH_HEAD"
NEW_SHA="$(in_app 'git rev-parse HEAD')"
echo "Now at: $(in_app 'git log --oneline -1')"

rollback() {
  say "ROLLING BACK to $PREV_SHA"
  in_app "git checkout -q -B deploy-live '$PREV_SHA'" || true
  in_app "cd backend && npm ci --omit=dev >/dev/null 2>&1" || true
  [ -d "$APP_DIR/frontend/dist.old" ] && in_app "cd frontend && mv dist \"dist.bad.\$(date +%s)\" && mv dist.old dist" || true
  systemctl restart "$API_SERVICE" || true
  has_unit "$WORKER_SERVICE" && systemctl restart "$WORKER_SERVICE" || true
  die "Deploy failed and the previous version was restored. Check: journalctl -u $API_SERVICE -n 60"
}

say "Installing backend dependencies"
in_app "cd backend && npm ci --omit=dev" || rollback

say "Building the frontend (the live site is untouched until this succeeds)"
in_app "cd frontend && npm ci && rm -rf dist.new && npx vite build --outDir dist.new --emptyOutDir" || { echo "Frontend build failed - live site unchanged."; in_app "git checkout -q -B deploy-live '$PREV_SHA'" || true; die "Build failed; nothing was changed on the live site."; }
[ -f "$APP_DIR/frontend/dist.new/index.html" ] || die "Build produced no index.html; live site unchanged."

say "Swapping in the new frontend"
in_app "cd frontend && rm -rf dist.old && { [ -d dist ] && mv dist dist.old || true; } && mv dist.new dist"

say "Restarting the BillStack API"
systemctl restart "$API_SERVICE"
has_unit "$WORKER_SERVICE" && systemctl restart "$WORKER_SERVICE" || true

say "Health check"
LIVE_PORT=""
for _ in $(seq 1 12); do
  sleep 3
  if LIVE_PORT="$(healthy)"; then break; fi
  LIVE_PORT=""
done
[ -n "$LIVE_PORT" ] || { echo "The API did not answer ${HEALTH_PATH} on any of its ports."; rollback; }
echo "Backend healthy on port $LIVE_PORT"

say "Checking for duplicate billing companies (preview only, nothing is changed)"
in_app "cd backend && node src/scripts/repair-billing-entities.js" || echo "Preview could not run; check MONGO_URI in backend/.env"
echo "If changes are listed above, apply them with: cd $APP_DIR/backend && node src/scripts/repair-billing-entities.js --apply"

say "Deployed $NEW_SHA. Open the site and press Ctrl+Shift+R."
echo "To undo: cd $APP_DIR/frontend && mv dist dist.bad && mv dist.old dist, then: cd $APP_DIR && git checkout -B deploy-live $PREV_SHA && systemctl restart $API_SERVICE"
