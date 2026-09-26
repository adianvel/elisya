# Production deployment

This stack runs on one Tencent VPS. PostgreSQL stores app and n8n data; Tencent COS stores private Payment proofs. Nuxt and Elysia are public through Caddy with automatic HTTPS. PostgreSQL, n8n, WAHA, and the task worker stay on the Docker network. The n8n and WAHA dashboards bind to loopback for SSH-tunnel access.

## Prepare the VPS

1. Install Docker Engine and the Compose plugin.
2. Point app and API DNS records to the VPS public IP. Allow inbound TCP 80 and 443 (UDP 443 is optional for HTTP/3); deny public access to database, n8n, WAHA, and worker ports.
3. Create a private COS bucket in Jakarta for Payment proofs. Disable public access and create a dedicated key limited to that bucket's object reads, writes, deletes, and list operation. Use a separate private COS bucket/key for offsite backups; ticket 09 adds the backup job.
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

## Updates

Pull the intended release commit, review its migrations, then run the same Compose deploy command. The migration runner serializes concurrent runs, applies each file transactionally, records a SHA-256 checksum, and stops if an applied migration changes. Add future migrations as new numbered SQL files; never edit a migration already used in staging or production.
