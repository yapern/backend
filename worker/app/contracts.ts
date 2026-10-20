import { z } from "@hono/zod-openapi";

// Retained in the URL for compatibility with the existing Yapern browser client.
export const PROJECT_ID = "90da3093-84b6-4cd7-a39a-a8afc39403b8";
export const ProjectParams = z.object({ projectId: z.literal(PROJECT_ID) });
export const protectedSecurity = [{ bearerAuth: [] }];

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 429 | 500 | 502 | 503 | 504,
    readonly code: string,
  ) {
    super(code);
  }
}
