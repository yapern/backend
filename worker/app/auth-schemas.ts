import { z } from "@hono/zod-openapi";

export const PublicUserSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  name: z.string(),
  created_at: z.string().datetime(),
  dob: z.string().nullable(),
}).openapi("User");

export const EmailLoginSchema = z.object({
  email: z.string().describe("Review account email; surrounding whitespace and case are ignored."),
  password: z.string(),
}).openapi("EmailLogin");

export const GoogleCredentialSchema = z.string().max(10_000);
export const GoogleLoginSchema = z.object({
  credential: GoogleCredentialSchema.describe("Google ID token for the configured Google client ID."),
}).openapi("GoogleLogin");

export const AppleCredentialSchema = z.object({
  identity_token: z.string().max(10_000).describe("Apple ID token for the native app's audience."),
  nonce: z.string().min(32).max(200).describe("Original nonce whose SHA-256 digest appears in the ID token."),
});
export const AppleLoginSchema = AppleCredentialSchema.extend({
  name: z.string().optional().describe("Used when creating the account; normalized and truncated to 120 characters."),
}).openapi("AppleLogin");

export const TokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RefreshTokenSchema = z.object({
  refresh_token: TokenSchema.describe("Refresh token issued by a native app login."),
}).openapi("RefreshToken");

export const AppTokensSchema = z.object({
  access_token: TokenSchema,
  refresh_token: TokenSchema,
  token_type: z.literal("Bearer"),
  expires_in: z.literal(900).describe("Access token lifetime in seconds. Refresh tokens last 90 days."),
  user: PublicUserSchema,
}).openapi("AppTokens");

export const DeleteAccountSchema = z.object({
  apple_identity_token: AppleCredentialSchema.shape.identity_token.optional(),
  apple_nonce: AppleCredentialSchema.shape.nonce.optional(),
  apple_authorization_code: z.string().max(5_000).optional(),
  google_id_token: GoogleCredentialSchema.optional(),
  google_access_token: z.string().max(5_000).optional(),
}).openapi("DeleteAccount", {
  description: "For Apple-linked accounts, send all three apple_* fields. For Google-linked accounts, send both google_* fields. Accounts without a linked provider need no body.",
});

export const ProviderErrorSchema = z.object({
  error: z.string(),
  provider: z.enum(["apple", "google"]),
}).openapi("ProviderError");
