#!/usr/bin/env sh
# Backs up OpenReview's PostgreSQL database with pg_dump (custom format) from the compose `postgres` service, and
# deletes backups older than KEEP_DAYS. Postgres holds everything worth keeping; Redis only holds the job queue and
# the repository cache volume is rebuilt by re-indexing.
#
# Usage:   deploy/backup.sh [BACKUP_DIR] [KEEP_DAYS]        (defaults: ./backups, 14)
# Cron:    17 3 * * * /opt/openreview/deploy/backup.sh /var/backups/openreview 14 >> /var/log/openreview-backup.log 2>&1
# Restore: docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < FILE
#
# Copy the backup directory off the server (object storage, another host): a backup on the same disk does not survive
# losing the server.
set -eu

cd "$(dirname "$0")/.."

dir=${1:-./backups}
keep_days=${2:-14}
case "$keep_days" in
  '' | *[!0-9]*)
    echo "KEEP_DAYS must be a whole number of days" >&2
    exit 2
    ;;
esac

mkdir -p "$dir"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$dir/openreview-$stamp.dump"

# Credentials come from the postgres container's own environment; nothing secret appears on this command line.
if ! docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$file.partial"; then
  rm -f "$file.partial"
  echo "backup failed: pg_dump exited with an error" >&2
  exit 1
fi
if [ ! -s "$file.partial" ]; then
  rm -f "$file.partial"
  echo "backup failed: pg_dump produced no output" >&2
  exit 1
fi
mv "$file.partial" "$file"

find "$dir" -name 'openreview-*.dump' -type f -mtime +"$keep_days" -delete
echo "backup written: $file"
