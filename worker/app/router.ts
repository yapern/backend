import { OpenAPIHono, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { jsonResponse } from "../shared/http";
import { errorResult, jsonResult, OkSchema, registerRoute, type ApiEnv } from "../shared/openapi";
import { registerAuthRoutes } from "./auth";
import { ApiError } from "./contracts";
import { registerDataRoutes } from "./data";
import { registerPreviewRoutes } from "./previews";

export const app = new OpenAPIHono<ApiEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  },
});

app.use("*", async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
});

const defaultOrigins = [
  "https://yapern.com", "https://www.yapern.com",
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:4173", "http://127.0.0.1:4173",
];
function allowedOrigins(env: Env): string[] {
  return env.YAPERN_ORIGINS?.split(",").map(origin => origin.trim()).filter(Boolean) ?? defaultOrigins;
}

for (const path of ["/auth/email", "/auth/session", "/tables/*", "/og-image"]) {
  app.use(path, cors({
    origin: (origin, c) => allowedOrigins(c.env).includes(origin) ? origin : "",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["apikey", "Authorization", "Content-Type"],
    maxAge: 600,
  }));
  app.use(path, async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins(c.env).includes(origin)) throw new ApiError(403, "origin_not_allowed");
    await next();
  });
  app.use(path, bodyLimit({
    maxSize: 16 * 1024,
    onError: c => c.json({ error: "request_too_large" }, 413),
  }));
}

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http", scheme: "bearer",
  description: "The token returned by Yapern email sign-in. The legacy apikey header is optional and grants no access.",
});
registerAuthRoutes(app);
registerDataRoutes(app);
registerPreviewRoutes(app);

registerRoute(app, {
  method: "get", path: "/health", operationId: "getHealth",
  tags: ["System"], summary: "Check that the API is running", security: [],
  responses: { 200: jsonResult(OkSchema, "The API is running. Does not check dependencies.") },
}, (c) => c.json({ ok: true }));
// Retain the existing health probe behavior for other HTTP methods.
app.all("/health", (c) => c.json({ ok: true }));

registerRoute(app, {
  method: "get", path: "/state", operationId: "getState",
  tags: ["System"], summary: "Increment and return the global visit count",
  description: "Reads the global AppState Durable Object, increments its persistent counter, and returns the new value. Requires the optional APP_STATE binding.",
  security: [],
  responses: {
    200: jsonResult(z.object({ visits: z.number().int().positive() }).openapi("AppState"), "Visit count after this request."),
    405: { ...errorResult("Only GET is supported (method_not_allowed)."), headers: {
      Allow: { schema: { type: "string", enum: ["GET"] } },
    } },
    503: errorResult("The APP_STATE binding is missing (durable_object_unavailable)."),
  },
}, (c) => handleState(c.req.raw, c.env));
app.all("/state", () => jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" }));

app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Yapern API",
    version: "1.0.0",
    description: "Yapern accounts, boards, messages, replies, link metadata previews, and system endpoints. Responses are not cached.",
  },
  servers: [{ url: "/", description: "Current environment" }],
  tags: [
    { name: "System" },
    { name: "Auth" }, { name: "Profiles" }, { name: "Boards" },
    { name: "Messages" }, { name: "Replies" }, { name: "Previews" },
  ],
});

app.get("/docs", swaggerUI({
  url: "/openapi.json", title: "Yapern API documentation",
  version: "5.34.0",
  docExpansion: "list", deepLinking: true,
  supportedSubmitMethods: ["get", "post", "patch", "delete"], validatorUrl: "",
}));
app.get("/docs/", (c) => c.redirect("/docs", 308));

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.code }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: "invalid_request" }, 400);
  if (error instanceof HTTPException && error.status < 500) return c.json({ error: "invalid_request" }, error.status);
  console.error("request_error", error);
  return c.json({ error: "internal_error" }, 500);
});

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  return app.fetch(request, env);
}

async function handleState(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
  }
  if (!env.APP_STATE) {
    return jsonResponse({ error: "durable_object_unavailable" }, 503);
  }
  const state = env.APP_STATE.get(env.APP_STATE.idFromName("global"));
  return state.fetch(new Request("https://internal/state", request));
}
