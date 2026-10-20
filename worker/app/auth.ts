import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { ApiError, protectedSecurity } from "./contracts";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";

const TOKEN_PATTERN = /^bff_us_[a-f0-9]{64}$/;
const SESSION_DAYS = 30;
const MINUTE_MS = 60_000;
const EMAIL_ATTEMPTS_PER_MINUTE = 10;
const IP_ATTEMPTS_PER_MINUTE = 60;
const MAX_ACTIVE_SESSIONS = 50;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

const EmailBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
}).strict().openapi("EmailAuthRequest");
const UserSchema = z.object({ id: z.string(), email: z.string() }).openapi("AuthUser");
const SessionSchema = z.object({
  id: z.string(), user_id: z.string(), expires_at: z.string(), created_at: z.string(),
}).openapi("AuthSession");
const AuthResult = z.object({
  token: z.string(), session: SessionSchema, user: UserSchema, created: z.boolean(),
}).openapi("EmailAuthResult");

interface CredentialRow {
  id: string;
  email: string;
  name: string;
  password_salt: string | null;
  password_hash: string | null;
}

export interface SessionIdentity {
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  email: string;
  name: string;
}

function database(env: Env): D1Database {
  if (!env.DB) throw new ApiError(503, "database_unavailable");
  return env.DB;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, "hex"), 64, SCRYPT_OPTIONS, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  return key.toString("hex");
}

async function verifyPassword(password: string, row: CredentialRow): Promise<boolean> {
  if (!row.password_hash || !row.password_salt ||
      !/^[a-f0-9]{128}$/.test(row.password_hash) || !/^[a-f0-9]{32}$/.test(row.password_salt)) return false;
  const actual = Buffer.from(await passwordHash(password, row.password_salt), "hex");
  return timingSafeEqual(actual, Buffer.from(row.password_hash, "hex"));
}

async function findCredential(db: D1Database, email: string): Promise<CredentialRow | null> {
  return db.prepare(`
    SELECT u.id, u.email, u.name, c.password_salt, c.password_hash
    FROM users AS u LEFT JOIN email_credentials AS c ON c.user_id = u.id
    WHERE lower(trim(u.email)) = ?
    ORDER BY CASE WHEN u.email = ? THEN 0 ELSE 1 END, u.created_at
    LIMIT 1
  `).bind(email, email).first<CredentialRow>();
}

async function enforceRateLimit(db: D1Database, email: string, request: Request): Promise<void> {
  const windowStart = Math.floor(Date.now() / MINUTE_MS);
  const keys: Array<readonly [string, number]> = [[`email:${sha256(email)}`, EMAIL_ATTEMPTS_PER_MINUTE]];
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) keys.push([`ip:${sha256(ip)}`, IP_ATTEMPTS_PER_MINUTE]);
  const statements = keys.map(([key]) => db.prepare(`
    INSERT INTO auth_rate_limits (key, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      window_start = excluded.window_start,
      attempts = CASE WHEN auth_rate_limits.window_start = excluded.window_start
        THEN auth_rate_limits.attempts + 1 ELSE 1 END
    RETURNING attempts
  `).bind(key, windowStart));
  const results = await db.batch(statements);
  if (results.some((result, index) => Number((result.results[0] as { attempts?: number } | undefined)?.attempts) > keys[index][1])) {
    throw new ApiError(429, "rate_limited");
  }
  if (randomBytes(1)[0] < 4) {
    await db.prepare(`DELETE FROM auth_rate_limits WHERE key IN (
      SELECT key FROM auth_rate_limits WHERE window_start < ? LIMIT 100
    )`).bind(windowStart - 1).run();
  }
}

async function issueSession(db: D1Database, row: CredentialRow, created: boolean) {
  const token = `bff_us_${randomBytes(32).toString("hex")}`;
  const tokenHash = sha256(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * MINUTE_MS).toISOString();
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?")
    .bind(row.id, createdAt).run();
  const inserted = await db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    SELECT ?, ?, ?, ? WHERE (
      SELECT COUNT(*) FROM sessions WHERE user_id = ? AND expires_at > ?
    ) < ?`).bind(tokenHash, row.id, expiresAt, createdAt, row.id, createdAt, MAX_ACTIVE_SESSIONS).run();
  if (inserted.meta.changes !== 1) throw new ApiError(503, "session_limit");
  if (randomBytes(1)[0] < 4) {
    await db.prepare(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE expires_at <= ? LIMIT 100
    )`).bind(createdAt).run();
  }
  return {
    token,
    session: { id: tokenHash, user_id: row.id, expires_at: expiresAt, created_at: createdAt },
    user: { id: row.id, email: row.email },
    created,
  };
}

export async function requireSession(request: Request, env: Env): Promise<SessionIdentity> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer (bff_us_[a-f0-9]{64})$/.exec(authorization);
  if (!match) throw new ApiError(401, "invalid_session");
  const row = await database(env).prepare(`
    SELECT s.user_id, s.token_hash, s.expires_at, s.created_at, u.email, u.name
    FROM sessions AS s JOIN users AS u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(sha256(match[1]), new Date().toISOString()).first<SessionIdentity>();
  if (!row) throw new ApiError(401, "invalid_session");
  return row;
}

export function registerAuthRoutes(app: Api): void {
  registerRoute(app, {
    method: "post", path: "/auth/email", operationId: "emailAuth",
    tags: ["Auth"], summary: "Sign in or create an email account", security: [],
    request: { body: { required: true, content: jsonContent(EmailBody) } },
    responses: {
      200: jsonResult(AuthResult, "Signed in."),
      201: jsonResult(AuthResult, "Account created and signed in."),
      400: errorResult("Invalid email or password, or weak new password."),
      401: errorResult("Incorrect email or password."),
      429: errorResult("Too many sign-in attempts."),
      503: errorResult("Database unavailable or session limit reached."),
    },
  }, async (c) => {
    const body = EmailBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "invalid_request");
    const { email, password } = body.data;
    const db = database(c.env);
    await enforceRateLimit(db, email, c.req.raw);
    let row = await findCredential(db, email);
    let created = false;
    if (row) {
      if (!await verifyPassword(password, row)) throw new ApiError(401, "invalid_credentials");
    } else {
      if (password.length < 8) throw new ApiError(400, "weak_password");
      const candidateId = randomUUID();
      const salt = randomBytes(16).toString("hex");
      const hash = await passwordHash(password, salt);
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)").bind(candidateId, email),
        db.prepare(`INSERT INTO email_credentials (user_id, password_salt, password_hash)
          SELECT id, ?, ? FROM users WHERE id = ? AND email = ?`)
          .bind(salt, hash, candidateId, email),
      ]);
      row = await findCredential(db, email);
      if (!row) throw new ApiError(500, "internal_error");
      created = row.id === candidateId;
      if (!created && !await verifyPassword(password, row)) throw new ApiError(401, "invalid_credentials");
    }
    const result = await issueSession(db, row, created);
    return c.json(result, created ? 201 : 200);
  });

  registerRoute(app, {
    method: "get", path: "/auth/session", operationId: "getAuthSession",
    tags: ["Auth"], summary: "Check a bearer session", security: protectedSecurity,
    responses: {
      200: jsonResult(z.object({ session: SessionSchema, user: UserSchema }).openapi("CurrentSession"), "Current session."),
      401: errorResult("Invalid or expired bearer token."),
      503: errorResult("Database unavailable."),
    },
  }, async (c) => {
    const identity = await requireSession(c.req.raw, c.env);
    return c.json({
      session: { id: identity.token_hash, user_id: identity.user_id,
        expires_at: identity.expires_at, created_at: identity.created_at },
      user: { id: identity.user_id, email: identity.email },
    });
  });

  registerRoute(app, {
    method: "delete", path: "/auth/session", operationId: "revokeAuthSession",
    tags: ["Auth"], summary: "Revoke a bearer session", security: protectedSecurity,
    responses: {
      200: jsonResult(z.object({ revoked: z.literal(true) }).openapi("RevokedSession"), "Token revoked."),
      401: errorResult("Invalid bearer token."),
      503: errorResult("Database unavailable."),
    },
  }, async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = /^Bearer (bff_us_[a-f0-9]{64})$/.exec(authorization)?.[1];
    if (!token || !TOKEN_PATTERN.test(token)) throw new ApiError(401, "invalid_session");
    await database(c.env).prepare("DELETE FROM sessions WHERE token_hash = ?").bind(sha256(token)).run();
    return c.json({ revoked: true });
  });
}
