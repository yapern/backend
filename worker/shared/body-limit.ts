import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "./openapi";

/** Bound the actual stream too, including requests with a misleading length. */
export function limitBody(maxBytes: number): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const request = c.req.raw;
    if (Number(request.headers.get("content-length")) > maxBytes) {
      return c.json({ error: "request_too_large" }, 413);
    }
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) return c.json({ error: "request_too_large" }, 413);
          chunks.push(value);
        }
      } catch {
        return c.json({ error: "invalid_request" }, 400);
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      c.req.raw = new Request(request, { body: bytes });
    }
    await next();
  };
}
