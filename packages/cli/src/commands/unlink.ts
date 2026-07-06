import { loadConfigSafe, saveConfig } from "../lib/config";
import { configPath } from "../lib/paths";
import { dim, errorMessage, green, yellow } from "../lib/ui";

const HTTP_TIMEOUT_MS = 10_000;

export async function runUnlink(): Promise<void> {
  const config = loadConfigSafe();
  if (!config.deviceToken) {
    console.log(dim("no device token saved — nothing to unlink"));
    return;
  }
  try {
    const res = await fetch(new URL("/api/unlink", config.relayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${config.deviceToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.ok) {
      console.log(green("device revoked on relay; Slack status cleared"));
    } else if (res.status === 401) {
      console.log(dim("relay no longer recognizes this device (already unlinked)"));
    } else {
      console.log(yellow(`relay responded ${res.status} — removing local token anyway`));
    }
  } catch (err) {
    console.log(
      yellow(`could not reach relay (${errorMessage(err)}) — removing local token anyway`),
    );
  }
  delete config.deviceToken;
  saveConfig(config);
  console.log(green(`device token removed from ${configPath()}`));
}
