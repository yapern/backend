import test from "node:test";
import assert from "node:assert/strict";
import { app, handleRequest } from "./router";

const origin = "https://api.yapern.com";
type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
};
type Operation = {
  operationId: string;
  summary: string;
  security: Record<string, string[]>[];
  parameters?: { name: string; in: string; required: boolean; schema: Schema }[];
  requestBody?: { required: boolean; content: { "application/json": { schema: Schema } } };
  responses: Record<string, {
    description: string;
    content: { "application/json": { schema: Schema } };
    headers?: Record<string, unknown>;
  }>;
};
type Document = {
  openapi: string;
  info: { title: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes: Record<string, { type: string; in?: string; name?: string; scheme?: string }>;
    schemas: Record<string, Schema>;
  };
};

async function document(): Promise<Document> {
  const response = await handleRequest(new Request(`${origin}/openapi.json`), {} as Env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return await response.json() as Document;
}

test("OpenAPI covers every business operation registered with Hono", async () => {
  const doc = await document();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "Yapern API");
  assert.deepEqual(doc.servers, [{ url: "/", description: "Current environment" }]);
  const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)).sort();
  const registered = app.routes.filter((route) => route.method !== "ALL"
    && !["/docs", "/docs/", "/openapi.json"].includes(route.path))
    .map((route) => `${route.method} ${route.path.replace(/:([^/]+)/g, "{$1}")}`).sort();
  assert.deepEqual(documented, registered);
  assert.deepEqual(documented, [
    "GET /health", "GET /state", "GET /auth/me", "POST /auth/logout",
    "POST /auth/google", "POST /auth/email", "POST /auth/app/anonymous",
    "POST /auth/app/google", "POST /auth/app/email", "POST /auth/app/apple",
    "GET /auth/app/me", "DELETE /auth/app/me", "POST /auth/app/refresh",
    "POST /auth/app/logout", "GET /admin/tables", "GET /admin/tables/{table}",
  ].sort());
  const ids = new Set<string>();
  for (const methods of Object.values(doc.paths)) {
    for (const operation of Object.values(methods)) {
      assert.ok(operation.summary);
      assert.ok(operation.operationId);
      assert.ok(!ids.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
      ids.add(operation.operationId);
      assert.ok(operation.responses["200"]?.content["application/json"].schema);
      for (const response of Object.values(operation.responses)) assert.ok(response.description);
      for (const security of operation.security) {
        for (const name of Object.keys(security)) assert.ok(doc.components.securitySchemes[name]);
      }
    }
  }
  // Verify generated component references resolve, including nested schemas.
  function checkReferences(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        assert.equal(typeof child, "string");
        const resolved = String(child).slice(2).split("/").reduce<unknown>((node, part) =>
          (node as Record<string, unknown> | undefined)?.[part], doc);
        assert.ok(resolved, `Unresolved reference: ${child}`);
      } else checkReferences(child);
    }
  }
  checkReferences(doc);
});

test("OpenAPI describes cookie/bearer auth, nullable sessions, and body constraints", async () => {
  const doc = await document();
  assert.equal(doc.components.securitySchemes.CookieSession.name, "groupicorn_session");
  assert.equal(doc.components.securitySchemes.NativeBearer.scheme, "bearer");
  assert.deepEqual(doc.paths["/auth/app/me"].get.security, [{ NativeBearer: [] }]);
  assert.deepEqual(doc.paths["/admin/tables"].get.security, [{ CookieSession: [] }]);
  const session = doc.paths["/auth/me"].get.responses["200"].content["application/json"].schema;
  assert.deepEqual(session.properties?.user.anyOf, [
    { $ref: "#/components/schemas/User" }, { type: "null" },
  ]);
  assert.ok(doc.paths["/auth/google"].post.responses["200"].headers?.["Set-Cookie"]);
  assert.equal(doc.paths["/auth/app/refresh"].post.requestBody?.required, true);
  assert.equal(doc.paths["/auth/app/me"].delete.requestBody?.required, false);
  assert.equal(doc.components.schemas.RefreshToken.properties?.refresh_token.pattern, "^[a-f0-9]{64}$");
  assert.equal(doc.components.schemas.AppleLogin.properties?.nonce.minLength, 32);
  assert.equal(doc.components.schemas.AppleLogin.properties?.nonce.maxLength, 200);
  const params = doc.paths["/admin/tables/{table}"].get.parameters!;
  assert.equal(params.find((param) => param.name === "table")?.required, true);
  assert.equal(params.find((param) => param.name === "q")?.schema.maxLength, 100);
  assert.ok(params.find((param) => param.name === "table")?.schema.enum?.includes("community-chat"));
  assert.ok(doc.paths["/auth/app/me"].delete.responses["409"]);
  assert.ok(doc.paths["/auth/app/me"].delete.responses["502"]);
  assert.ok(doc.paths["/auth/app/anonymous"].post.responses["429"].headers?.["Retry-After"]);
});

test("docs is public HTML pointing at the generated document", async () => {
  const response = await handleRequest(new Request(`${origin}/docs`), {} as Env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/html/);
  const html = await response.text();
  assert.match(html, /Yapern API documentation/);
  assert.match(html, /SwaggerUIBundle/);
  assert.match(html, /url: '\/openapi\.json'/);
  const redirect = await handleRequest(new Request(`${origin}/docs/`), {} as Env);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/docs");
});

test("documentation requests can call auth on the same origin", async () => {
  const response = await handleRequest(new Request(`${origin}/auth/logout`, {
    method: "POST", headers: { Origin: origin },
  }), {} as Env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.match(response.headers.get("set-cookie")!, /groupicorn_session=; Max-Age=0/);
  const preflight = await handleRequest(new Request(`${origin}/auth/app/me`, {
    method: "OPTIONS", headers: { Origin: "http://localhost:5173" },
  }), {} as Env);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers")!, /authorization/);
});

test("Zod validation preserves JSON errors, provider errors, and authentication ordering", async () => {
  const cases = [
    { path: "/auth/email", body: "{", status: 400, error: "invalid_request" },
    { path: "/auth/email", body: "[]", status: 400, error: "invalid_request" },
    { path: "/auth/email", body: '{"email":3,"password":"x"}', status: 400, error: "invalid_request" },
    { path: "/auth/google", body: "{}", status: 401, error: "invalid_google_credential" },
    { path: "/auth/app/google", body: '{"credential":1}', status: 401, error: "invalid_google_credential" },
  ];
  for (const { path, body, status, error } of cases) {
    const response = await handleRequest(new Request(`${origin}${path}`, {
      method: "POST", body, headers: { "content-type": "application/json", Origin: origin },
    }), {} as Env);
    assert.equal(response.status, status, path);
    assert.deepEqual(await response.json(), { error });
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
  const emptyDb = { DB: {} } as Env;
  for (const path of ["/auth/app/refresh", "/auth/app/logout"]) {
    const response = await handleRequest(new Request(`${origin}${path}`, {
      method: "POST", body: '{"refresh_token":"invalid"}',
    }), emptyDb);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  const deletion = await handleRequest(new Request(`${origin}/auth/app/me`, { method: "DELETE" }), emptyDb);
  assert.equal(deletion.status, 401);
  const admin = await handleRequest(new Request(`${origin}/admin/tables/users?offset=-1`), {} as Env);
  assert.equal(admin.status, 401);
  const apple = await handleRequest(new Request(`${origin}/auth/app/apple`, {
    method: "POST", body: '{"identity_token":"invalid","nonce":"short"}',
  }), emptyDb);
  assert.equal(apple.status, 401);
  assert.deepEqual(await apple.json(), { error: "invalid_apple_credential" });
});

test("body limits, rate limiting, and method handling survive the router migration", async () => {
  const largeBody = await handleRequest(new Request(`${origin}/auth/email`, {
    method: "POST", body: "{}", headers: { "content-length": "2001" },
  }), {} as Env);
  assert.equal(largeBody.status, 400);
  const rateLimited = await handleRequest(new Request(`${origin}/auth/app/anonymous`, {
    method: "POST", headers: { "CF-Connecting-IP": "127.0.0.1" },
  }), { ANONYMOUS_SIGNUP_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get("retry-after"), "60");
  for (const [path, method, expected] of [
    ["/state", "HEAD", 405], ["/state", "POST", 405],
    ["/auth/me", "POST", 404], ["/auth/me", "HEAD", 404],
    ["/admin/tables", "POST", 405], ["/admin/tables", "HEAD", 405],
    ["/health", "POST", 200],
  ] as const) {
    const response = await handleRequest(new Request(`${origin}${path}`, { method }), {} as Env);
    assert.equal(response.status, expected, `${method} ${path}`);
  }
});

test("admin pagination schemas preserve bounds, defaults, and trimmed search behavior", async () => {
  const env = { DB: {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          return sql.includes("FROM sessions")
            ? { id: "admin", email: "oneone@gmail.com" } : { total: 0 };
        },
        async all() { return { results: [] }; },
      };
    },
  } } as unknown as Env;
  async function read(query: string) {
    return handleRequest(new Request(`${origin}/admin/tables/herds?${query}`, {
      headers: { Cookie: "groupicorn_session=test-admin-session" },
    }), env);
  }
  for (const query of ["", "offset=", "offset=000", "offset=1000000", `q=${"x".repeat(100)}`, `q=%20${"x".repeat(100)}%20`]) {
    const response = await read(query);
    assert.equal(response.status, 200, query);
    const body = await response.json() as { offset: number; limit: number };
    assert.equal(body.offset, query === "offset=1000000" ? 1_000_000 : 0);
    assert.equal(body.limit, 25);
  }
  for (const query of ["offset=-1", "offset=1.5", "offset=1000001", "offset=9007199254740992", "offset=abc"]) {
    const response = await read(query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "invalid_offset" });
  }
  const tooLong = await read(`q=${"x".repeat(101)}`);
  assert.equal(tooLong.status, 400);
  assert.deepEqual(await tooLong.json(), { error: "invalid_query" });
});
