import { z } from "@hono/zod-openapi";
import { requireSession } from "./auth";
import { protectedSecurity } from "./contracts";
import { previewImage, previewStatus, requestPreview } from "./preview-jobs";
import { errorResult, jsonResult, registerRoute, type Api } from "../shared/openapi";

const DiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  httpStatus: z.number().int().optional().describe("Website HTTP status for page failures; browser service HTTP status for service failures."),
  contentType: z.string().optional(),
  providerCode: z.number().int().optional(),
});
const PreviewSchema = z.object({
  image: z.string().url().nullable(),
  source: z.enum(["og", "twitter", "screenshot", "favicon", "placeholder"]),
  status: z.enum(["ready", "pending", "failed"]),
  previewId: z.string().uuid().optional(),
  statusUrl: z.string().url().optional(),
  error: z.string().optional().describe("Specific screenshot failure code, including on HTTP 200 terminal fallbacks."),
  diagnostics: z.object({ metadata: DiagnosticSchema.optional(), screenshot: DiagnosticSchema.optional() }).optional()
    .describe("Reasons metadata or screenshot generation fell back. Present on queued, failed, and cached results when available."),
}).openapi("LinkPreview");
const RequestSchema = z.object({ url: z.string().min(1).max(2048) }).strict().openapi("LinkPreviewRequest");
const IdSchema = z.object({ id: z.string().uuid() });
const ImageParams = z.object({ filename: z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i,
).openapi({ example: "861232f2-d908-438f-b3ba-f46f718254e8.jpg" }) });
const pendingResult = {
  ...jsonResult(PreviewSchema, "Screenshot queued or processing. Poll statusUrl with the same bearer session."),
  headers: { "Retry-After": { schema: { type: "integer" as const, example: 3 } } },
};
const imageResponses = {
  200: {
    description: "A cached screenshot. Public, unguessable URL suitable for a shared message image.",
    content: { "image/jpeg": { schema: { type: "string" as const, format: "binary" } } },
    headers: {
      "Cache-Control": { schema: { type: "string" as const } },
      "Content-Length": { schema: { type: "integer" as const } },
      ETag: { schema: { type: "string" as const } },
    },
  },
  400: errorResult("Invalid preview ID."),
  404: errorResult("Image missing, expired, or owner deleted."),
};

export function registerPreviewRoutes(app: Api): void {
  registerRoute(app, {
    method: "post", path: "/og-image", operationId: "getLinkPreview",
    tags: ["Previews"], summary: "Fetch a link image, or queue a screenshot when metadata is missing",
    security: protectedSecurity,
    request: { body: { required: true, content: { "application/json": { schema: RequestSchema } } } },
    responses: {
      200: jsonResult(PreviewSchema, "Ready metadata or cached screenshot, or a terminal favicon/placeholder fallback."),
      202: pendingResult,
      400: errorResult("Invalid URL."),
      401: errorResult("A valid session is required."),
      429: errorResult("Daily screenshot or cached preview limit reached."),
      503: errorResult("Browser, storage, or queue unavailable."),
    },
  }, async (c) => {
    const identity = await requireSession(c.req.raw, c.env);
    const { url } = await c.req.json() as { url: string };
    const result = await requestPreview(c.env, identity.user_id, url, new URL(c.req.url).origin);
    if (result.status === 202) c.header("retry-after", "3");
    return c.json(result.data, result.status);
  });

  registerRoute(app, {
    method: "get", path: "/previews/{id}", operationId: "getLinkPreviewStatus",
    tags: ["Previews"], summary: "Read your queued screenshot status", security: protectedSecurity,
    request: { params: IdSchema },
    responses: {
      200: jsonResult(PreviewSchema, "Ready screenshot or terminal favicon/placeholder fallback."),
      202: pendingResult,
      400: errorResult("Invalid preview ID."),
      401: errorResult("A valid session is required."),
      404: errorResult("Preview missing, expired, or owned by another user."),
      503: errorResult("Queue unavailable while recovering a stalled preview."),
    },
  }, async (c) => {
    const identity = await requireSession(c.req.raw, c.env);
    const result = await previewStatus(c.env, identity.user_id, c.req.param("id")!, new URL(c.req.url).origin);
    if (result.status === 202) c.header("retry-after", "3");
    return c.json(result.data, result.status);
  });

  for (const method of ["get", "head"] as const) {
    registerRoute(app, {
      method, path: "/preview-images/{filename}", operationId: method === "get" ? "getLinkPreviewImage" : "headLinkPreviewImage",
      tags: ["Previews"], summary: method === "get" ? "Read a public screenshot" : "Read public screenshot headers",
      security: [], request: { params: ImageParams }, responses: imageResponses,
    }, (c) => previewImage(c.req.raw, c.env, c.req.param("filename")!.slice(0, -4)));
  }
}
