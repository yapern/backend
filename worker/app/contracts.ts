export const protectedSecurity = [{ bearerAuth: [] }];

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 429 | 500 | 502 | 503 | 504,
    readonly code: string,
  ) {
    super(code);
  }
}
