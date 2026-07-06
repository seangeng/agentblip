export interface Env {
  // Bindings
  STORE: KVNamespace;
  ASSETS: Fetcher;

  // Vars
  BASE_URL: string;
  SLACK_CLIENT_ID: string;

  // Secrets (wrangler secret put)
  SLACK_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}
