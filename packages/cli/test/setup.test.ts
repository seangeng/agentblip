import { describe, expect, it } from "vitest";
import { resolveRelayUrl } from "../src/commands/setup";

describe("resolveRelayUrl", () => {
  it("accepts hosted and self-hosted https urls", () => {
    expect(resolveRelayUrl("https://agentblip.com")).toBe("https://agentblip.com");
    expect(resolveRelayUrl("  https://relay.corp.example  ")).toBe(
      "https://relay.corp.example",
    );
    expect(resolveRelayUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("rejects garbage and non-http protocols", () => {
    expect(() => resolveRelayUrl("")).toThrow(/invalid relay URL/);
    expect(() => resolveRelayUrl("not a url")).toThrow(/invalid relay URL/);
    expect(() => resolveRelayUrl("ftp://example.com")).toThrow(/must be http/);
  });
});
