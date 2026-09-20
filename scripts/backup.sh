#!/usr/bin/env bash
#
# Nightly backup (PRD §11): pg_dump to the Unraid array, 30 days retained.
#
# Run from cron on the Unraid host, not inside the app container, so a backup
# still happens when the app is down:
#
#   0 3 * * *  /mnt/user/appdata/ballast/scripts/backup.sh >> /var/log/ballast-backup.log 2>&1
#
# A backup nobody has restored is a guess. Before the Google Sheet is retired,
# run a restore into a scratch database and check a figure you know:
#
#   createdb ballast_restore_test
#   gunzip -c <a dump> | psql ballast_restore_test
#   psql ballast_restore_test -c "select count(*) from events;"

set -euo pipefail

BACKUP_DIR="${BALLAST_BACKUP_DIR:-/mnt/user/backups/ballast}"
RETAIN_DAYS="${BALLAST_BACKUP_RETAIN_DAYS:-30}"
DB_URL="${DATABASE_MIGRATION_URL:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  echo "error: set DATABASE_MIGRATION_URL (or DATABASE_URL) to the owner's connection string" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
target="$BACKUP_DIR/ballast-$stamp.sql.gz"

# Write to a temp name first: a half-written file that looks like a backup is
# worse than an obviously missing one.
tmp="$target.partial"
pg_dump --no-owner --no-privileges --format=plain "$DB_URL" | gzip -9 > "$tmp"

# A dump with no events table is a dump of the wrong database.
#
# grep -c, not grep -q: under `set -o pipefail` an early-exiting grep -q sends
# SIGPIPE to gunzip, the pipeline reports failure, and a perfectly good backup
# gets deleted. grep -c reads to the end.
if ! gunzip -c "$tmp" | grep -c 'CREATE TABLE public\.events' > /dev/null; then
  echo "error: dump does not contain the events table; refusing to keep it" >&2
  rm -f "$tmp"
  exit 1
fi

mv "$tmp" "$target"
echo "backed up to $target ($(du -h "$target" | cut -f1))"

deleted=$(find "$BACKUP_DIR" -name 'ballast-*.sql.gz' -type f -mtime "+$RETAIN_DAYS" -print -delete | wc -l)
echo "pruned $deleted backup(s) older than $RETAIN_DAYS days"

remaining=$(find "$BACKUP_DIR" -name 'ballast-*.sql.gz' -type f | wc -l)
echo "$remaining backup(s) retained"
