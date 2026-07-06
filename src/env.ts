export interface Env {
  // Bindings (client assets are served by the vite plugin — no ASSETS binding)
  STORE: KVNamespace;

  // Vars
  BASE_URL: string;
  SLACK_CLIENT_ID: string;

  // Secrets (wrangler secret put)
  SLACK_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}
