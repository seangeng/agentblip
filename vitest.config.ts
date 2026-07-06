import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "workers/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@agentblip/core": new URL("./packages/core/src/index.ts", import.meta.url)
        .pathname,
    },
  },
});
