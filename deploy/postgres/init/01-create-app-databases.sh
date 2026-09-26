#!/usr/bin/env bash
set -e

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=palawa_password="$PALAWA_DB_PASSWORD" \
  --set=n8n_password="$N8N_DB_PASSWORD" <<'SQL'
CREATE ROLE palawa LOGIN PASSWORD :'palawa_password';
CREATE DATABASE palawa OWNER palawa;
CREATE ROLE n8n LOGIN PASSWORD :'n8n_password';
CREATE DATABASE n8n OWNER n8n;
SQL
