# WhatsApp workflows

These exports use n8n's built-in Webhook, HTTP Request, IF, and Code nodes. They do not need community nodes. Import both files under `workflows/`, attach credentials, then activate them.

## Configure credentials in n8n

Create Header Auth credentials and select them on the matching nodes after import. Exports contain no secrets or machine-specific credential IDs.

| Credential | Header name | Value | Nodes |
| --- | --- | --- | --- |
| `Palawa WAHA inbound` | `Authorization` | `Bearer <WAHA_WEBHOOK_SECRET>` | Inbound Webhook |
| `Palawa Elysia API` | `Authorization` | `Bearer <N8N_WEBHOOK_SECRET>` | Inbound HTTP Request nodes |
| `Palawa WAHA API` | `X-Api-Key` | `<WAHA_API_KEY>` | WAHA media download and send nodes |
| `Palawa outbound worker` | `Authorization` | `Bearer <N8N_WEBHOOK_SECRET>` | Outbound Webhook |

Use separate random values for `WAHA_WEBHOOK_SECRET`, `N8N_WEBHOOK_SECRET`, and `WAHA_API_KEY`. Configure the same `N8N_WEBHOOK_SECRET` in Elysia and the task worker. Never put secret values in a workflow export.

## Configure URLs and WAHA

The workflow URLs assume the Docker network service names `api`, `waha`, and `n8n`:

- Elysia API: `http://api:8000`
- WAHA API: `http://waha:3000`
- Task worker callback: set `N8N_WHATSAPP_OUTBOUND_URL=http://n8n:5678/webhook/palawa/whatsapp/outbound`
- Configure WAHA's `WAHA_BASE_URL=http://waha:3000` so media URLs in events are reachable from n8n.

Set these hostnames to the matching internal service names if deployment uses different names. Keep API, n8n, and WAHA on a private Docker network. Publish only the webhook/reverse-proxy endpoints that need external access.

Configure the WAHA session to send `message` events to n8n's internal production webhook:

```json
{
  "name": "default",
  "config": {
    "webhooks": [
      {
        "url": "http://n8n:5678/webhook/palawa/whatsapp/inbound",
        "events": ["message"],
        "customHeaders": [
          { "name": "Authorization", "value": "Bearer <WAHA_WEBHOOK_SECRET>" }
        ]
      }
    ]
  }
}
```

Enable WAHA media download for JPEG, PNG, WebP, and PDF. The inbound workflow reads `payload.media.url`, downloads it with the WAHA API key, extracts the Hold ULID from the caption, and posts the multipart file to Elysia. If the Hold ID is missing or media is unavailable, it asks the Customer to resend the receipt. The API independently validates sender, Hold ownership, file type, and size.

The inbound webhook acknowledges ignored outgoing/group/LID events without starting an execution. For accepted events it responds only after Elysia finishes; a failed assistant or proof request can therefore be retried by WAHA. Assistant replies and successful proof confirmations go through the durable outbox once; the inbound workflow does not send those responses inline. Elysia stores the WAHA event ID and returns the same assistant/media result on replay.

The outbound webhook returns success only after WAHA accepts `sendText`. The worker marks the outbox row sent only after that 2xx. Delivery is at least once: a timeout after WAHA accepted a message can cause a duplicate, but replayed messages cannot create a second Hold or Payment.

New business states, including cancellation and Refund decisions, should insert a stable-key WhatsApp notification with `persistWhatsAppNotification` in the same PostgreSQL transaction as the state change. The existing outbox worker will retry it without adding n8n business rules.

References: [WAHA receive messages](https://waha.devlike.pro/docs/how-to/receive-messages/), [WAHA events and custom headers](https://waha.devlike.pro/docs/how-to/events/), [WAHA send messages](https://waha.devlike.pro/docs/how-to/send-messages/), and [n8n Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).
