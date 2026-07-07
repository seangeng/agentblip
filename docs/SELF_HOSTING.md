# Self-hosting agentblip

The relay is a single Cloudflare Worker with one KV namespace and two secrets. No
database, no queue, no cron. Cloudflare's free tier covers a team comfortably.

What the relay stores (KV only):

- `pair:{code}` — pairing records: `{deviceId, pollSecretHash, status, deviceToken?,
  team?}`, single-use, expire after 15 minutes. `deviceToken` is the plaintext device
  token and exists only during the OAuth → CLI handover: it is handed to the CLI once
  (single-use, with a 60-second delivery grace) and gone within the 15-minute TTL even
  if the CLI never polls. Outside that handshake window the device token is never
  stored, only its SHA-256 hash.
- `pairdev:{deviceId}` — pairing code, keyed by device for polling, expires after
  15 minutes
- `pairstate:{nonce}` — OAuth CSRF state → pairing code, expires after 10 minutes
- `device:{sha256(token)}` — device records: `{slackUserId, teamId, teamName,
  encToken, createdAt, lastSeenAt, provisional?}`. The Slack token (`encToken`) is
  AES-GCM encrypted at rest. A record that is never used after pairing stays
  provisional and expires after 24 hours.
- `rl:{scope}:{key}:{minute}` — rate-limit counters, expire after 2 minutes

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

The app requests two user scopes: `users.profile:write` (set your status) and
`users.profile:read` (read the current status before each update, so agentblip never
overwrites a status it didn't set). It can touch your status and nothing else.

> **Upgrading an existing install?** The `users.profile:read` scope is new. Update
> your Slack app's manifest at [api.slack.com/apps](https://api.slack.com/apps) (your
> app → **App Manifest** page) to match `docs/slack-app-manifest.json`, then have
> users re-pair (`agentblip unlink && agentblip setup`) so their tokens carry the new
> scope. Tokens without it keep working, but degrade to the old blind-push behavior —
> the relay reports `readable: false` and the daemon can't respect existing statuses.

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
agentblip setup --relay-url https://your.domain
```

Or run plain `agentblip setup`, choose **relay** at the mode select
(relay / slack / console), and enter `https://your.domain` at the **Relay URL**
prompt (it defaults to `https://agentblip.com`). The `AGENTBLIP_RELAY_URL`
environment variable overrides the configured `relayUrl` at runtime.

Everyone on your team does the same — one relay serves any number of devices and
Slack users.

## No server at all: direct mode

If even a dumb relay is more infrastructure than you want, `agentblip setup` offers
direct mode: the daemon calls Slack's API from your machine using a user token from
your own Slack app (same manifest, minus the redirect URL plumbing). Nothing sits
between you and Slack.
