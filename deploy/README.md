# Production deployment

This stack runs on one Tencent VPS. PostgreSQL stores app and n8n data; Tencent COS stores private Payment proofs. Nuxt and Elysia are public through Caddy with automatic HTTPS. PostgreSQL, n8n, WAHA, and the task worker stay on the Docker network. The n8n and WAHA dashboards bind to loopback for SSH-tunnel access.

## Prepare the VPS

1. Install Docker Engine and the Compose plugin.
2. Point app and API DNS records to the VPS public IP. Allow inbound TCP 80 and 443 (UDP 443 is optional for HTTP/3); deny public access to database, n8n, WAHA, and worker ports.
3. Create a private COS bucket in Jakarta for Payment proofs. Disable public access and create a dedicated key limited to that bucket's object reads, writes, deletes, and list operation. Create a second private bucket/key for database backups and a 30-day lifecycle rule on its postgres/ prefix.
4. Clone this repository and copy .env.production.example to .env.production. Replace every replace-me value with an independent generated secret. Keep this file outside Git and restrict it to the deployment user.
5. Set the actual organization ID, email provider settings, AI key, and WhatsApp number. Use the Tencent-issued bucket name including its APPID suffix.

Generate random values on the VPS with:

    openssl rand -hex 32

Create separate .env.staging and .env.production files with different credentials, URLs, and COS buckets. Deploy each with a distinct Compose project name so PostgreSQL and application volumes remain separate. Production owns public ports 80/443; staging runs without the Caddy profile on separate loopback ports, so both stacks can stay up together.

Copy the staging template and replace every secret, URL, and bucket before starting it:

    cp .env.staging.example .env.staging
    docker compose --project-name palawa-staging --env-file .env.staging -f docker-compose.production.yml up -d --build

Tunnel staging access to the VPS:

    ssh -L 3100:127.0.0.1:3100 -L 8100:127.0.0.1:8100 -L 16789:127.0.0.1:16789 -L 13000:127.0.0.1:13000 deploy@YOUR_VPS

Then open the app at http://127.0.0.1:3100, n8n at http://127.0.0.1:16789, and WAHA at http://127.0.0.1:13000.

## Deploy production

Run from the repository root after creating .env.production:

    docker compose --profile public-edge --project-name palawa-production --env-file .env.production -f docker-compose.production.yml up -d --build

The first startup creates separate palawa and n8n databases and roles. The migration service applies checksummed, ordered SQL migrations before the API and task worker start. Production deployment requires a fresh Palawa database for the initial baseline. Do not run db:push against staging or production; keep it for local development.

Check services with:

    docker compose --profile public-edge --project-name palawa-production --env-file .env.production -f docker-compose.production.yml ps

The API readiness endpoint checks PostgreSQL, pg-boss, and COS. The worker readiness endpoint checks its registered queues and PostgreSQL. Compose also monitors the web app, n8n, WAHA, and PostgreSQL. Caddy blocks public access to the API health paths.

## Configure n8n and WAHA

Open the n8n editor through an SSH tunnel:

    ssh -L 5678:127.0.0.1:5678 deploy@YOUR_VPS

Then browse to http://127.0.0.1:5678. Import the workflows in integrations/n8n/workflows, configure their Header Auth credentials from .env.production, and activate them. Configure the WAHA session webhook URL as http://n8n:5678/webhook/palawa/whatsapp/inbound and use WAHA_WEBHOOK_SECRET as its Authorization Bearer value.

Open the WAHA dashboard with a second SSH tunnel:

    ssh -L 3000:127.0.0.1:3000 deploy@YOUR_VPS

Then browse to http://127.0.0.1:3000. Use WAHA_API_KEY for the corresponding n8n API credential. WAHA Core is pinned to a versioned free image tag; do not replace it with a Plus image.

## Backups and alerts

The backup service starts after the migration runner, uploads custom-format dumps of the palawa and n8n databases to BACKUP_S3_BUCKET under postgres/<UTC backup ID>/, and repeats hourly. It writes the manifest last, so incomplete uploads aren't treated as restore points. The backup-role one-shot service creates or updates a dedicated read-only PostgreSQL role, including on an existing data volume. Backup failures and state changes in PostgreSQL, pg-boss, COS, the worker, n8n, WAHA, and the default WAHA session alert TECHNICAL_OPERATOR_EMAIL through SMTP. Docker health reports when the last successful backup is over two hours old.

Keep the BACKUP_S3_* key separate from the proof bucket key. The backup bucket contains the app and n8n databases; the proof bucket already lives outside the VPS and remains the source for Payment proof files after database recovery. Keep a secure copy of .env.production, including N8N_ENCRYPTION_KEY, outside the VPS.

## Recovery runbook

### Queue backlog

Check service health and recent logs:

    docker compose --profile public-edge --project-name palawa-production --env-file .env.production -f docker-compose.production.yml ps
    docker compose --profile public-edge --project-name palawa-production --env-file .env.production -f docker-compose.production.yml logs --tail=100 tasks n8n waha backup

Inspect pg-boss queue counts:

    docker compose --project-name palawa-production --env-file .env.production -f docker-compose.production.yml exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d palawa -c "SELECT name, ready_count, active_count, failed_count FROM pgboss.queue ORDER BY ready_count DESC"'

Fix the failing dependency before retrying or cancelling queued work. Do not delete pg-boss rows to clear a backlog.

### n8n or WAHA session loss

For n8n database readiness, check /healthz/readiness and the n8n logs. Its workflows and credentials are in the n8n PostgreSQL database; restore both databases from the same backup ID if n8n data is lost. Retain the original N8N_ENCRYPTION_KEY so n8n can decrypt credentials.

For a disconnected WAHA session, open the loopback dashboard through the SSH tunnel, check the default session status, and reconnect it by scanning the displayed QR code when WAHA reports SCAN_QR_CODE. Keep the waha_sessions volume; a VPS replacement requires pairing the session again.

### Restore on a replacement VPS

1. Create a fresh production VPS, install Docker, configure DNS and ports, and place the saved .env.production there. Use a new project name if the old VPS is still running.
2. Restore both databases before starting the application services:

       docker compose --profile restore --project-name palawa-production --env-file .env.production -f docker-compose.production.yml run --rm restore restore BACKUP_ID

3. Start the services and verify API, worker, n8n, WAHA, and backup health:

       docker compose --profile public-edge --project-name palawa-production --env-file .env.production -f docker-compose.production.yml up -d --build
       docker compose --profile public-edge --project-name palawa-production --env-file .env.production -f docker-compose.production.yml ps

4. Sign in as the Owner, open a Payment proof, and confirm the restored Payment still retrieves its private file from COS.

### Staging restore drill

Run this drill against staging at least once before release. Record the newest Booking/Payment timestamps before restore, start the timer, restore the latest complete manifest, bring the staging app back up, and confirm a Payment proof opens. Record the backup ID, data-loss window, recovery time, and proof check. The acceptance target is no more than one hour of Booking/Payment loss and recovery within four hours.

Stop services that write to the databases while restoring:

    docker compose --project-name palawa-staging --env-file .env.staging -f docker-compose.production.yml stop api tasks n8n backup
    docker compose --profile restore --project-name palawa-staging --env-file .env.staging -f docker-compose.production.yml run --rm restore restore BACKUP_ID
    docker compose --project-name palawa-staging --env-file .env.staging -f docker-compose.production.yml up -d

The CI backup drill performs the same core checks against temporary PostgreSQL and S3-compatible storage on every push.

## Updates

Pull the intended release commit, review its migrations, then run the same Compose deploy command. The migration runner serializes concurrent runs, applies each file transactionally, records a SHA-256 checksum, and stops if an applied migration changes. Add future migrations as new numbered SQL files; never edit a migration already used in staging or production.
