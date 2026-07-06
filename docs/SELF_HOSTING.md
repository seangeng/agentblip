# Self-hosting agentblip

The relay is a single Cloudflare Worker with one KV namespace and two secrets. No
database, no queue, no cron. Cloudflare's free tier covers a team comfortably.

What the relay stores (KV only):

- `pair:{code}` — pairing codes, expire after 15 minutes
- `device:{sha256(token)}` — device records: your Slack user/team ids plus an
  AES-GCM-encrypted Slack token. The device token itself is never stored, only its
  SHA-256 hash.
- `rl:…` — rate-limit counters, expire after 2 minutes

## Prerequisites

- A Cloudflare account (free tier is fine) with your domain as a zone, if you want a
  custom domain
- Node.js 20+
- A Slack workspace where you're allowed to create apps

## 1. Fork and clone

```bash
git clone https://github.com/<you>/agentblip.git
cd agentblip
npm ci
npx wrangler login
```

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create STORE
```

Copy the generated id into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "STORE", "id": "<your-kv-id>" }
]
```

## 3. Create your Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From a manifest** → pick your workspace.
2. Paste the contents of [`docs/slack-app-manifest.json`](slack-app-manifest.json).
3. Before creating, change the redirect URL to your domain:
   `https://your.domain/api/slack/callback`.
4. Create the app, then from **Basic Information** copy the **Client ID** and
   **Client Secret**.

The app requests a single user scope, `users.profile:write` — it can set your status
and nothing else.

## 4. Set secrets

```bash
npx wrangler secret put SLACK_CLIENT_SECRET
# paste the client secret from step 3

npx wrangler secret put TOKEN_ENCRYPTION_KEY
# paste the output of: openssl rand -base64 32
```

`TOKEN_ENCRYPTION_KEY` encrypts Slack tokens at rest (AES-GCM), so a KV dump alone
can't leak them. Rotating it invalidates every stored token — users just re-pair.

## 5. Set vars and routes

In `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "your.domain", "custom_domain": true }
],
"vars": {
  "BASE_URL": "https://your.domain",
  "SLACK_CLIENT_ID": "<client id from step 3>"
}
```

`BASE_URL` must match the hostname that actually serves the Worker — it's used to
build pairing verify URLs and the OAuth redirect. If you skip the custom domain,
delete `routes` and use your `*.workers.dev` URL as `BASE_URL` (and in the Slack app's
redirect URL).

## 6. Deploy

```bash
npm run deploy
curl https://your.domain/api/health   # sanity check
```

Pushes to `main` auto-deploy via `.github/workflows/deploy.yml` once you add
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repo secrets.

## 7. Point the CLI at your relay

```bash
agentblip setup
# choose "self-hosted" → enter https://your.domain
```

Everyone on your team does the same — one relay serves any number of devices and
Slack users.

## No server at all: direct mode

If even a dumb relay is more infrastructure than you want, `agentblip setup` offers
direct mode: the daemon calls Slack's API from your machine using a user token from
your own Slack app (same manifest, minus the redirect URL plumbing). Nothing sits
between you and Slack.
