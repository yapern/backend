import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { errorResult, registerRoute, type Api } from "../shared/openapi";
import { ApiError } from "./contracts";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const filenamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const contentTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

type ImageFolder = "board-logos" | "board-messages";

export async function storeBoardImage(env: Env, file: File, folder: ImageFolder): Promise<string> {
  const invalidImage = folder === "board-logos" ? "invalid_logo" : "invalid_message_image";
  if (file.size > MAX_IMAGE_BYTES) throw new ApiError(413, "request_too_large");
  if (!file.size) throw new ApiError(415, invalidImage);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const matches = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
  const format = matches([137, 80, 78, 71, 13, 10, 26, 10]) ? "png"
    : matches([255, 216, 255]) ? "jpg"
    : matches([71, 73, 70, 56, 55, 97]) || matches([71, 73, 70, 56, 57, 97]) ? "gif"
    : matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8) ? "webp" : null;
  if (!format || file.type !== contentTypes[format]) throw new ApiError(415, invalidImage);
  if (!env.BUCKET) throw new ApiError(503, folder === "board-logos" ? "logo_storage_unavailable" : "image_storage_unavailable");
  const key = `${folder}/${randomUUID()}.${format}`;
  try {
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: contentTypes[format], cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch (error) {
    await deleteBoardImage(env, `/${key}`, folder);
    throw error;
  }
  return `/${key}`;
}

export async function deleteBoardImage(env: Env, url: string | null, folder: ImageFolder): Promise<void> {
  const prefix = `/${folder}/`;
  if (!url?.startsWith(prefix) || !filenamePattern.test(url.slice(prefix.length))) return;
  try {
    await env.BUCKET.delete(url.slice(1));
  } catch (error) {
    // Cleanup must not turn a committed write into a failed request.
    console.error("board_image_cleanup_failed", { url, error });
  }
}

export function registerBoardImageRoutes(app: Api): void {
  for (const [folder, resource, tag] of [["board-logos", "BoardLogo", "Boards"], ["board-messages", "MessageImage", "Messages"]] as const) {
    for (const method of ["get", "head"] as const) {
      registerRoute(app, {
        method, path: `/${folder}/{filename}`, operationId: `${method}${resource}`,
        tags: [tag], summary: `Read public ${folder === "board-logos" ? "board logo" : "message image"}${method === "head" ? " headers" : ""}`, security: [],
        request: { params: z.object({ filename: z.string().regex(filenamePattern) }) },
        responses: {
          200: { description: "Image with immutable caching headers.", content: Object.fromEntries(
            Object.values(contentTypes).map(type => [type, { schema: { type: "string", format: "binary" } }]),
          ) },
          400: errorResult("Invalid image filename (invalid_request)."),
          404: errorResult("This image is unavailable (not_found)."),
        },
      }, async c => {
        const filename = c.req.param("filename")!;
        if (!filenamePattern.test(filename) || !c.env.BUCKET) throw new ApiError(404, "not_found");
        const key = `${folder}/${filename}`;
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
}
