import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { handleRequest } from "../app/router";
import { createTestDatabase } from "./database";

export function adminFixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const { sqlite } = database;
  const adminToken = `bff_us_${"a".repeat(64)}`, memberToken = `bff_us_${"b".repeat(64)}`;
  for (const [id, email, token] of [
    ["admin", " OneOne@Gmail.com ", adminToken], ["member", "member@example.com", memberToken],
  ]) {
    sqlite.prepare("INSERT INTO users (id, email, name, google_sub, created_at) VALUES (?, ?, ?, ?, '2025-01-01T00:00:00.000Z')")
      .run(id, email, id, `private-provider-${id}`);
    sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00.000Z')")
      .run(createHash("sha256").update(token).digest("hex"), id);
  }
  const emails: EmailMessageBuilder[] = [];
  const env = {
    DB: database.db,
    MARKETING_EMAIL: { async send(message: EmailMessageBuilder) {
      emails.push(message);
      return { messageId: "marketing-123" };
    } },
  } as unknown as Env;
  const call = (path: string, { token = adminToken, method = "GET", origin = "https://yapern.com", body, headers = {} }: {
    token?: string | null; method?: string; origin?: string | null; body?: string; headers?: Record<string, string>;
  } = {}) => handleRequest(new Request(`https://api.yapern.com${path}`, {
    method, headers: {
      ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers,
    }, ...(body === undefined ? {} : { body }),
  }), env);
  return { ...database, env, adminToken, memberToken, emails, call };
}
