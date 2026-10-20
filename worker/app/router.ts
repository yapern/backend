import { OpenAPIHono, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { jsonResponse } from "../shared/http";
import { errorResult, jsonResult, OkSchema, registerRoute, type ApiEnv } from "../shared/openapi";

export const app = new OpenAPIHono<ApiEnv>();

app.use("*", async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
});

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
    description: "System endpoints for the Yapern backend. Responses are not cached.",
  },
  servers: [{ url: "/", description: "Current environment" }],
  tags: [
    { name: "System" },
  ],
});

app.get("/docs", swaggerUI({
  url: "/openapi.json", title: "Yapern API documentation",
  version: "5.34.0",
  docExpansion: "list", deepLinking: true,
  supportedSubmitMethods: ["get"], validatorUrl: "",
}));
app.get("/docs/", (c) => c.redirect("/docs", 308));

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((error, c) => {
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
