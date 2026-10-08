#!/usr/bin/env bash
# Deploy BillStack on the VPS: update code, rebuild frontend, restart backend.
# Usage (on the server, as root):
#   curl -fsSL https://raw.githubusercontent.com/Nemnidhi/toor-billstack/<branch>/scripts/deploy-vps.sh | BRANCH=<branch> bash
# Optional: APP_DIR=/path/to/toor-billstack  WEB_ROOT=/var/www/billstack
set -euo pipefail

BRANCH="${BRANCH:-main}"
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "Locating the BillStack checkout"
if [ -z "${APP_DIR:-}" ]; then
  APP_DIR="$(find / -maxdepth 5 -type d -name .git -path '*billstack*' -not -path '*/node_modules/*' 2>/dev/null | head -1 | xargs -r dirname)"
fi
[ -n "${APP_DIR:-}" ] && [ -d "$APP_DIR/frontend" ] && [ -d "$APP_DIR/backend" ] || die "Could not find the app. Re-run with APP_DIR=/path/to/toor-billstack"
echo "App directory: $APP_DIR"
cd "$APP_DIR"

say "Saving a rollback point"
PREV_SHA="$(git rev-parse HEAD)"
echo "Current commit: $PREV_SHA  (roll back with: cd $APP_DIR && git checkout $PREV_SHA, then re-run this script with BRANCH=$PREV_SHA)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git stash push -m "pre-deploy $(date +%F-%H%M)" >/dev/null && echo "Local server edits stashed (git stash list)."
fi

say "Fetching $BRANCH"
git fetch origin "$BRANCH"
git checkout -B "deploy-$(date +%Y%m%d-%H%M)" FETCH_HEAD
echo "Now at: $(git log --oneline -1)"

say "Installing backend dependencies"
(cd backend && npm ci --omit=dev)

say "Building frontend"
(cd frontend && npm ci && npm run build)

say "Publishing frontend build"
if [ -z "${WEB_ROOT:-}" ]; then
  WEB_ROOT="$(grep -rhoE '^\s*root\s+[^;]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | awk '{print $2}' | grep -iE 'bill|toor|office' | head -1 || true)"
fi
if [ -n "$WEB_ROOT" ] && [ "$(readlink -f "$WEB_ROOT")" != "$(readlink -f "$APP_DIR/frontend/dist")" ]; then
  mkdir -p "$WEB_ROOT"
  cp -a "$WEB_ROOT" "${WEB_ROOT%/}.bak-$(date +%Y%m%d-%H%M)" 2>/dev/null || true
  rsync -a --delete "$APP_DIR/frontend/dist/" "$WEB_ROOT/" 2>/dev/null || { rm -rf "${WEB_ROOT:?}"/*; cp -a "$APP_DIR/frontend/dist/." "$WEB_ROOT/"; }
  echo "Copied build to $WEB_ROOT (previous copy kept as ${WEB_ROOT%/}.bak-*)"
else
  echo "nginx serves $APP_DIR/frontend/dist directly (or root not detected) - build is already in place."
fi

say "Restarting backend"
restarted=no
if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name"'; then
  pm2 restart all --update-env && pm2 save >/dev/null 2>&1 || true
  restarted=pm2
fi
for unit in $(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '{print $1}' | grep -iE 'bill|toor' || true); do
  systemctl restart "$unit" && echo "Restarted $unit" && restarted=systemd
done
[ "$restarted" = no ] && echo "WARNING: no pm2 process or billstack systemd service found - restart the backend manually."
nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true

say "Health check"
sleep 4
PORT="$(grep -E '^PORT=' backend/.env 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-5000}"
if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Backend healthy on port $PORT"
else
  echo "WARNING: health check on port $PORT did not answer. Check logs: pm2 logs  OR  journalctl -u <service> -n 50"
fi

say "Done. Open the site and press Ctrl+F5."
