import { createRoute, OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import type { Handler } from "hono";

export type ApiEnv = { Bindings: Env };
export type Api = OpenAPIHono<ApiEnv>;

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
export const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");

export function jsonContent(schema: z.ZodType) {
  return { "application/json": { schema } };
}

export function jsonResult(schema: z.ZodType, description: string) {
  return { description, content: jsonContent(schema) };
}

export function errorResult(description: string) {
  return jsonResult(ErrorSchema, description);
}

export function registerRoute(app: Api, definition: RouteConfig, handler: Handler<ApiEnv>): void {
  const route = createRoute({
    ...definition,
    responses: { 500: errorResult("Unexpected server error."), ...definition.responses },
  });
  // Handlers validate with the shared Zod schemas after their authentication and
  // availability checks. Automatic pre-handler validation would change those
  // checks' ordering and the API's existing provider-specific error responses.
  app.openAPIRegistry.registerPath(route);
  app.on(route.method, route.getRoutingPath(), handler);
}
