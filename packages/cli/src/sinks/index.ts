import type { Config } from "../lib/config";
import { createConsoleSink } from "./console";
import { createRelaySink } from "./relay";
import { createSlackSink } from "./slack";
import type { Sink } from "./types";

export type { Sink } from "./types";

export function createSink(config: Config): Sink {
  switch (config.mode) {
    case "relay":
      if (!config.deviceToken) {
        throw new Error('mode is "relay" but no device token — run `agentblip setup`');
      }
      return createRelaySink(config.relayUrl, config.deviceToken);
    case "slack":
      if (!config.slackToken) {
        throw new Error('mode is "slack" but no Slack token — run `agentblip setup`');
      }
      return createSlackSink(config.slackToken);
    case "console":
      return createConsoleSink();
  }
}
