# scripts

Local-dev helpers. None of these are used in production.

## test-webhook.ts

Sends a synthetic Google Form submission to the local web server, with a
correctly-signed HMAC header. This is the same shape Apps Script would send.

### Prerequisites

- `pnpm dev:web` is running (default `http://localhost:3000`).
- `pnpm dev:worker` is running (otherwise the submission will sit in `PENDING`).
- `WEBHOOK_SECRET` is exported in your shell or present in `.env`.
- For an end-to-end run with no external services, the following mocks should
  be on (set in `.env`, then restart the dev servers):
  - `AUTH_MOCK=true` — sign in to the admin UI without Google.
  - `DRIVE_MOCK=true` — worker fabricates a tiny stream instead of calling Drive.
  - `ALGO_ENGINE_MOCK=true` — worker returns deterministic mock scores.
  - `RESEND_MOCK=true` — worker logs the approval email instead of sending it.

### Run

```bash
pnpm test:webhook \
  --email=demo-admin@example.com \
  --name="Demo User" \
  --category=cooking \
  --files=1
```

Available flags:

| Flag         | Default                                          |
|--------------|--------------------------------------------------|
| `--email`    | `demo-admin@example.com`                         |
| `--name`     | `Demo User`                                      |
| `--category` | `general`                                        |
| `--files`    | `1` (number of file entries to include)          |
| `--url`      | `http://localhost:3000/api/webhooks/google-form` |

The script prints the request body, status code, and response body so you
can confirm the submission was accepted.
