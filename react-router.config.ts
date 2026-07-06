import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Required for @cloudflare/vite-plugin, which builds via the Vite
  // environment API and outputs to dist/<env> instead of build/.
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
