#!/usr/bin/env bash
# Nightly backup of the BillStack database (invoices, payments, accounts, users).
#
# Runs as the app owner (billstack). Reads MONGO_URI from backend/.env, writes one
# compressed archive per day to $BACKUP_DIR and keeps the last $KEEP_DAYS days.
# The connection string (with its password) is passed to mongodump through a
# private config file, never on the command line, so it does not show in `ps`.
#
# Install once (as root):
#   crontab -u billstack -l 2>/dev/null | { cat; echo '20 2 * * * bash /home/billstack/apps/toor-billstack/scripts/backup-billstack.sh >> /home/billstack/backup.log 2>&1'; } | crontab -u billstack -
# Restore (stop the API first, then):
#   mongorestore --config <file with uri: ...> --gzip --archive=<file> --drop
#
# Optional environment: APP_DIR, BACKUP_DIR (default ~/backups/billstack), KEEP_DAYS (default 14)
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/home/billstack/apps/toor-billstack}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/billstack}"
KEEP_DAYS="${KEEP_DAYS:-14}"
ENV_FILE="$APP_DIR/backend/.env"

command -v mongodump >/dev/null || { echo "mongodump is not installed (mongodb-database-tools)"; exit 1; }
[ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE"; exit 1; }

MONGO_URI="$(grep -E '^MONGO_URI=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
[ -n "$MONGO_URI" ] || { echo "MONGO_URI is not set in $ENV_FILE"; exit 1; }

mkdir -p "$BACKUP_DIR"
CONFIG="$(mktemp)"
trap 'rm -f "$CONFIG"' EXIT
printf 'uri: "%s"\n' "$MONGO_URI" > "$CONFIG"

STAMP="$(date +%F-%H%M)"
TARGET="$BACKUP_DIR/billstack-$STAMP.archive.gz"
mongodump --config "$CONFIG" --gzip --archive="$TARGET.partial" --quiet
mv "$TARGET.partial" "$TARGET"

find "$BACKUP_DIR" -maxdepth 1 -name 'billstack-*.archive.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name '*.partial' -mtime +1 -delete

echo "$(date -Is) backup done: $TARGET ($(du -h "$TARGET" | cut -f1))"
