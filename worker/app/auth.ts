import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { errorResult, jsonContent, jsonResult, OkSchema, registerRoute, type ApiEnv } from "../shared/openapi";
import { authCorsHeaders, authJson, currentUser, expiredSessionCookie, publicUser, revokeSession } from "./auth-core";
import { handleEmailLogin, handleGoogleLogin, handleNativeEmailLogin, handleNativeGoogleLogin } from "./auth-login";
import { handleAppAnonymous, handleAppDelete, handleAppLogout, handleAppMe, handleAppRefresh } from "./auth-app";
import { handleNativeAppleLogin } from "./auth-apple";
import {
  AppleLoginSchema, AppTokensSchema, DeleteAccountSchema, EmailLoginSchema,
  GoogleLoginSchema, ProviderErrorSchema, PublicUserSchema, RefreshTokenSchema,
} from "./auth-schemas";

export const authApp = new OpenAPIHono<ApiEnv>();

authApp.use("/auth/*", async (c, next) => {
  const headers = authCorsHeaders(c.req.raw);
  if (headers === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  for (const [key, value] of Object.entries(headers)) c.header(key, value);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  if (c.req.method === "HEAD") return c.body(null, 404);
  await next();
});

const browserSecurity: RouteConfig["security"] = [{}, { CookieSession: [] }];
const optionalBearer: RouteConfig["security"] = [{}, { NativeBearer: [] }];
const originError = { 403: errorResult("The request Origin is not allowed (origin_not_allowed).") };
const invalidBody = errorResult("Missing, malformed, or oversized JSON (invalid_request).");
const unavailable = errorResult("Authentication or the identity provider is unavailable.");
const cookieHeader = {
  "Set-Cookie": {
    description: "Secure, HttpOnly groupicorn_session cookie with SameSite=None; valid for 30 days.",
    schema: { type: "string" as const },
  },
};

// Login handlers and their contracts are registered together. Native logins may
// receive an anonymous Bearer token to transfer anonymous account data.
const logins: {
  path: string; operationId: string; native: boolean; summary: string; description: string;
  schema: z.ZodType; maxBytes: number; handler: typeof handleGoogleLogin;
  result: z.ZodType; errors: RouteConfig["responses"];
}[] = [
  {
    path: "/auth/google", operationId: "loginWithGoogle", native: false,
    summary: "Sign in with Google and set a browser session cookie",
    description: "Accepts a Google ID token for the configured Google client ID.",
    schema: GoogleLoginSchema, maxBytes: 20_000, handler: handleGoogleLogin,
    result: z.object({ user: PublicUserSchema, created: z.boolean() }),
    errors: {
      401: errorResult("Invalid Google credential (invalid_google_credential)."),
      409: errorResult("Google identity is linked to another account (invalid_google_credential)."),
    },
  },
  {
    path: "/auth/email", operationId: "loginWithEmail", native: false,
    summary: "Sign in with the review account and set a browser session cookie",
    description: "Supports the configured review account only; not general email/password registration.",
    schema: EmailLoginSchema, maxBytes: 2_000, handler: handleEmailLogin,
    result: z.object({ user: PublicUserSchema }),
    errors: { 401: errorResult("Invalid review account credentials (invalid_credentials).") },
  },
  {
    path: "/auth/app/google", operationId: "nativeLoginWithGoogle", native: true,
    summary: "Sign in with Google and issue native app tokens",
    description: "An optional anonymous Bearer token transfers anonymous account data.",
    schema: GoogleLoginSchema, maxBytes: 20_000, handler: handleNativeGoogleLogin,
    result: AppTokensSchema,
    errors: {
      401: errorResult("Invalid Google credential (invalid_google_credential)."),
      409: errorResult("Google identity is linked to another account (identity_conflict)."),
    },
  },
  {
    path: "/auth/app/email", operationId: "nativeLoginWithEmail", native: true,
    summary: "Sign in with the review account and issue native app tokens",
    description: "Supports the review account only. An optional anonymous Bearer token transfers anonymous account data.",
    schema: EmailLoginSchema, maxBytes: 2_000, handler: handleNativeEmailLogin,
    result: AppTokensSchema,
    errors: { 401: errorResult("Invalid review account credentials (invalid_credentials).") },
  },
  {
    path: "/auth/app/apple", operationId: "nativeLoginWithApple", native: true,
    summary: "Sign in with Apple and issue native app tokens",
    description: "An optional anonymous Bearer token transfers anonymous account data. Creating an account requires a verified email (email_required, 400).",
    schema: AppleLoginSchema, maxBytes: 20_000, handler: handleNativeAppleLogin,
    result: AppTokensSchema,
    errors: {
      400: errorResult("Missing/malformed/oversized JSON (invalid_request) or no verified email for a new account (email_required)."),
      401: errorResult("Invalid Apple credential (invalid_apple_credential)."),
      409: errorResult("Apple identity is linked to another account (identity_conflict)."),
    },
  },
];

for (const login of logins) {
  registerRoute(authApp, {
    method: "post", path: login.path, operationId: login.operationId,
    tags: [login.native ? "Native authentication" : "Browser authentication"],
    summary: login.summary,
    description: `${login.description} JSON body limit: ${login.maxBytes.toLocaleString("en-US")} bytes when Content-Length is supplied.`,
    security: login.native ? optionalBearer : [],
    request: { body: { required: true, content: jsonContent(login.schema) } },
    responses: {
      200: { ...jsonResult(login.result, "Signed in."), ...(login.native ? {} : { headers: cookieHeader }) },
      400: invalidBody, ...originError, 503: unavailable, ...login.errors,
    },
  }, (c) => login.handler(c.req.raw, c.env, authCorsHeaders(c.req.raw)!));
}

registerRoute(authApp, {
  method: "post", path: "/auth/app/anonymous", operationId: "createAnonymousSession",
  tags: ["Native authentication"], summary: "Create an anonymous account and native session",
  description: "Requires the anonymous signup rate limiter and a Cloudflare-provided CF-Connecting-IP. No request body is required.",
  security: [],
  responses: {
    200: jsonResult(AppTokensSchema, "Anonymous account and tokens created."), ...originError,
    429: { ...errorResult("Anonymous signup rate limit exceeded (rate_limited)."), headers: {
      "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer", example: 60 } },
    } },
    503: unavailable,
  },
}, async (c) => {
  const address = c.req.header("CF-Connecting-IP");
  const headers = authCorsHeaders(c.req.raw)!;
  if (!address || !c.env.ANONYMOUS_SIGNUP_LIMIT) {
    return authJson({ error: "auth_unavailable" }, 503, headers);
  }
  const { success } = await c.env.ANONYMOUS_SIGNUP_LIMIT.limit({ key: `anonymous:${address}` });
  if (!success) return authJson({ error: "rate_limited" }, 429, { ...headers, "retry-after": "60" });
  return handleAppAnonymous(c.env, headers);
});

registerRoute(authApp, {
  method: "get", path: "/auth/app/me", operationId: "getNativeSession",
  tags: ["Native authentication"], summary: "Get the current native app user",
  security: [{ NativeBearer: [] }],
  responses: {
    200: jsonResult(z.object({ user: PublicUserSchema }), "Current user."),
    401: errorResult("Missing, invalid, or expired access token (unauthorized)."), ...originError,
  },
}, (c) => handleAppMe(c.req.raw, c.env, authCorsHeaders(c.req.raw)!));

registerRoute(authApp, {
  method: "delete", path: "/auth/app/me", operationId: "deleteNativeAccount",
  tags: ["Native authentication"], summary: "Delete the current account and revoke its provider credentials",
  description: "Permanently deletes the account and associated data. Linked accounts require fresh provider credentials; otherwise no body is needed. JSON body limit: 20,000 bytes when Content-Length is supplied.",
  security: [{ NativeBearer: [] }], request: { body: { required: false, content: jsonContent(DeleteAccountSchema) } },
  responses: {
    200: jsonResult(z.object({ deleted: z.literal(true) }), "Account deleted."),
    401: errorResult("Missing, invalid, or expired access token (unauthorized)."), ...originError,
    409: jsonResult(ProviderErrorSchema, "Fresh provider credentials are required (provider_reauthentication_required)."),
    502: jsonResult(ProviderErrorSchema, "Provider credentials could not be verified or revoked (provider_revocation_failed)."),
    503: errorResult("Authentication or legacy deletion is unavailable (auth_unavailable, legacy_deletion_unavailable, legacy_deletion_failed)."),
  },
}, (c) => handleAppDelete(c.req.raw, c.env, authCorsHeaders(c.req.raw)!));

const nativeSessions: {
  path: string; operationId: string; summary: string; description: string;
  handler: typeof handleAppRefresh; result: z.ZodType;
  security: RouteConfig["security"]; errors: RouteConfig["responses"];
}[] = [
  { path: "/auth/app/refresh", operationId: "refreshNativeSession",
    summary: "Rotate a refresh token and issue a new token pair",
    description: "Refresh tokens are single-use and expire after 90 days.",
    handler: handleAppRefresh, result: AppTokensSchema, security: [],
    errors: { 401: errorResult("Unknown, expired, revoked, or already used refresh token (invalid_refresh_token).") } },
  { path: "/auth/app/logout", operationId: "logoutNativeSession",
    summary: "Revoke a refresh token and the supplied access token",
    description: "An optional Bearer access token is revoked if it belongs to the refresh token's user. Unknown refresh tokens succeed.",
    handler: handleAppLogout, result: OkSchema, security: optionalBearer, errors: {} },
];
for (const session of nativeSessions) {
  registerRoute(authApp, {
    method: "post", path: session.path, operationId: session.operationId,
    tags: ["Native authentication"], summary: session.summary,
    description: `${session.description} JSON body limit: 2,000 bytes when Content-Length is supplied.`,
    security: session.security, request: { body: { required: true, content: jsonContent(RefreshTokenSchema) } },
    responses: {
      200: jsonResult(session.result, "Session updated."), 400: invalidBody,
      ...originError, 503: unavailable, ...session.errors,
    },
  }, (c) => session.handler(c.req.raw, c.env, authCorsHeaders(c.req.raw)!));
}

registerRoute(authApp, {
  method: "get", path: "/auth/me", operationId: "getBrowserSession",
  tags: ["Browser authentication"], summary: "Get the browser session, or null when signed out",
  security: browserSecurity,
  responses: {
    200: jsonResult(z.object({ user: z.union([PublicUserSchema, z.null()]) }), "Current session; user is null without a valid cookie."),
    ...originError, 503: unavailable,
  },
}, async (c) => {
  try {
    const user = await currentUser(c.env, c.req.raw);
    return c.json({ user: user ? publicUser(user) : null });
  } catch (error) {
    console.error("auth_me_error", error);
    return c.json({ error: "auth_unavailable" }, 503);
  }
});

registerRoute(authApp, {
  method: "post", path: "/auth/logout", operationId: "logoutBrowserSession",
  tags: ["Browser authentication"], summary: "Revoke the browser session and clear its cookie",
  security: browserSecurity,
  responses: {
    200: { ...jsonResult(OkSchema, "Session revoked, including when already signed out."), headers: {
      "Set-Cookie": { description: "Expires the groupicorn_session cookie.", schema: { type: "string" } },
    } },
    ...originError, 503: unavailable,
  },
}, async (c) => {
  try {
    await revokeSession(c.env, c.req.raw);
    c.header("set-cookie", expiredSessionCookie());
    return c.json({ ok: true });
  } catch (error) {
    console.error("auth_logout_error", error);
    return c.json({ error: "auth_unavailable" }, 503);
  }
});

authApp.all("/auth/*", (c) => c.json({ error: "not_found" }, 404));
