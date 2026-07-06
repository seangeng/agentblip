import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  // core is a private workspace package (and pulls in zod) — bundle both so the
  // published CLI only depends on commander + chokidar at runtime.
  noExternal: ["@agentblip/core"],
});
