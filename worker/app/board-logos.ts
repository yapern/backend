import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { errorResult, registerRoute, type Api } from "../shared/openapi";
import { ApiError } from "./contracts";

export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const filenamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const contentTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export async function storeBoardLogo(env: Env, file: File): Promise<string> {
  if (file.size > MAX_LOGO_BYTES) throw new ApiError(413, "request_too_large");
  if (!file.size) throw new ApiError(415, "invalid_logo");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const matches = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
  const format = matches([137, 80, 78, 71, 13, 10, 26, 10]) ? "png"
    : matches([255, 216, 255]) ? "jpg"
    : matches([71, 73, 70, 56, 55, 97]) || matches([71, 73, 70, 56, 57, 97]) ? "gif"
    : matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8) ? "webp" : null;
  if (!format || file.type !== contentTypes[format]) throw new ApiError(415, "invalid_logo");
  if (!env.BUCKET) throw new ApiError(503, "logo_storage_unavailable");
  const key = `board-logos/${randomUUID()}.${format}`;
  try {
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: contentTypes[format], cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch (error) {
    await deleteBoardLogo(env, `/${key}`);
    throw error;
  }
  return `/${key}`;
}

export async function deleteBoardLogo(env: Env, url: string | null): Promise<void> {
  if (!url?.startsWith("/board-logos/") || !filenamePattern.test(url.slice("/board-logos/".length))) return;
  try {
    await env.BUCKET.delete(url.slice(1));
  } catch (error) {
    // A cleanup failure must not turn a committed board update into a failed save.
    console.error("board_logo_cleanup_failed", { url, error });
  }
}

export function registerBoardLogoRoutes(app: Api): void {
  for (const method of ["get", "head"] as const) {
    registerRoute(app, {
      method, path: "/board-logos/{filename}", operationId: method === "get" ? "getBoardLogo" : "headBoardLogo",
      tags: ["Boards"], summary: method === "get" ? "Read a public board logo" : "Read board logo headers", security: [],
      request: { params: z.object({ filename: z.string().regex(filenamePattern) }) },
      responses: {
        200: { description: "Board logo with immutable caching headers.", content: Object.fromEntries(
          Object.values(contentTypes).map(type => [type, { schema: { type: "string", format: "binary" } }]),
        ) },
        400: errorResult("Invalid logo filename (invalid_request)."),
        404: errorResult("This logo is unavailable (not_found)."),
      },
    }, async c => {
      const filename = c.req.param("filename")!;
      if (!filenamePattern.test(filename) || !c.env.BUCKET) throw new ApiError(404, "not_found");
      const key = `board-logos/${filename}`;
      const object = method === "head" ? await c.env.BUCKET.head(key) : await c.env.BUCKET.get(key);
      if (!object) throw new ApiError(404, "not_found");
      return new Response(method === "head" ? null : (object as R2ObjectBody).body, { headers: {
        "content-type": contentTypes[filename.split(".").at(-1)!],
        "content-length": String(object.size), etag: object.httpEtag,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff", "access-control-allow-origin": "*",
      } });
    });
  }
}
