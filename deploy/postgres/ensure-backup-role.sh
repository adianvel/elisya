#!/bin/sh
set -eu

attempt=0
while ! psql -h "$PGHOST" -U "$PGUSER" -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo 'PostgreSQL did not become ready for backup role setup' >&2; exit 1; fi
  sleep 2
done

attempt=0
while [ "$(psql -h "$PGHOST" -U "$PGUSER" -d postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname IN ('palawa', 'n8n')")" != 2 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo 'Palawa and n8n databases were not initialized' >&2; exit 1; fi
  sleep 2
done

psql -h "$PGHOST" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'backup') THEN
    EXECUTE 'CREATE ROLE backup LOGIN';
  END IF;
END
$$;
SQL

psql -h "$PGHOST" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -v backup_password="$BACKUP_DB_PASSWORD" <<'SQL'
ALTER ROLE backup WITH LOGIN PASSWORD :'backup_password';
GRANT pg_read_all_data TO backup;
GRANT CONNECT ON DATABASE palawa TO backup;
GRANT CONNECT ON DATABASE n8n TO backup;
SQL
