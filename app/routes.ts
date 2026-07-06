import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("pair", "routes/pair.tsx"),
  route("privacy", "routes/privacy.tsx"),
] satisfies RouteConfig;
