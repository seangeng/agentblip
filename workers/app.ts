import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import type { Env } from "../src/env";
import { api } from "../src/api";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const app = new Hono<{ Bindings: Env }>();

// www → apex
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === "www.agentblip.com") {
    url.hostname = "agentblip.com";
    return c.redirect(url.toString(), 301);
  }
  await next();
});

app.route("/api", api);

// React Router v7 SSR handles all page routes
const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

app.all("*", (c) =>
  requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx },
  }),
);

export default app;
