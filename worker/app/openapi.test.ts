import test from "node:test";
import assert from "node:assert/strict";
import { app, handleRequest } from "./router";

const origin = "https://api.yapern.com";
type Operation = {
  operationId: string;
  summary: string;
  security: Record<string, string[]>[];
  responses: Record<string, {
    description: string;
    content: Record<string, { schema: unknown }>;
  }>;
};
type Document = {
  openapi: string;
  info: { title: string };
  servers: { url: string }[];
  tags: { name: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes?: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
};

async function document(): Promise<Document> {
  const response = await handleRequest(new Request(`${origin}/openapi.json`), {} as Env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return await response.json() as Document;
}

test("OpenAPI covers every API operation registered with Hono", async () => {
  const doc = await document();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "Yapern API");
  assert.deepEqual(doc.servers, [{ url: "/", description: "Current environment" }]);
  const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)).sort();
  const registered = [...new Set(app.routes.filter((route) => route.method !== "ALL"
    && !["/docs", "/docs/", "/openapi.json"].includes(route.path))
    .map((route) => `${route.method} ${route.path.replace(/:([A-Za-z_]\w*)/g, "{$1}")}`))].sort();
  assert.deepEqual(documented, registered);
  assert.deepEqual(documented, [
    "DELETE /auth/session",
    "DELETE /tables/messages",
    "GET /auth/session",
    "GET /board-logos/{filename}",
    "GET /board-messages/{filename}",
    "GET /health",
    "GET /preview-images/{filename}",
    "GET /previews/{id}",
    "GET /state",
    "GET /tables/boards",
    "GET /tables/messages",
    "GET /tables/replies",
    "GET /tables/users",
    "HEAD /board-logos/{filename}",
    "HEAD /board-messages/{filename}",
    "HEAD /preview-images/{filename}",
    "PATCH /tables/boards",
    "PATCH /tables/users",
    "POST /auth/email",
    "POST /og-image",
    "POST /tables/boards",
    "POST /tables/messages",
    "POST /tables/replies",
  ]);
  const ids = new Set<string>();
  for (const methods of Object.values(doc.paths)) {
    for (const operation of Object.values(methods)) {
      assert.ok(operation.summary);
      assert.ok(operation.operationId);
      assert.ok(!ids.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
      ids.add(operation.operationId);
      const success = operation.responses["200"] ?? operation.responses["201"];
      assert.ok(Object.values(success.content).some(content => content.schema));
      for (const response of Object.values(operation.responses)) assert.ok(response.description);
      assert.ok(Array.isArray(operation.security));
      for (const security of operation.security) assert.deepEqual(security, { bearerAuth: [] });
    }
  }
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

test("OpenAPI contains only current schemas and tags", async () => {
  const doc = await document();
  assert.deepEqual(Object.keys(doc.components.securitySchemes ?? {}), ["bearerAuth"]);
  assert.deepEqual(Object.keys(doc.components.schemas).sort(), [
    "AppState", "AuthSession", "AuthUser", "Board", "CreateBoard", "CreateMessage", "CreateMessageImage", "CreateReply",
    "CurrentSession", "EmailAuthRequest", "EmailAuthResult", "Error", "LinkPreview", "LinkPreviewRequest",
    "Message", "Ok", "PublicProfile", "Reply", "RevokedSession", "UpdateBoardDescription", "UpdateBoardLogo", "UpdateProfile",
  ]);
  assert.deepEqual(doc.tags, [
    { name: "System" }, { name: "Auth" }, { name: "Profiles" }, { name: "Boards" },
    { name: "Messages" }, { name: "Replies" }, { name: "Previews" },
  ]);
});

test("OpenAPI describes preview diagnostic stages and safe failure fields", async () => {
  const doc = await document();
  const preview = doc.components.schemas.LinkPreview as { properties?: Record<string, { properties?: Record<string, unknown> }> };
  assert.ok(preview.properties?.diagnostics);
  assert.ok(preview.properties?.error);
  const stages = preview.properties!.diagnostics.properties!;
  assert.ok(stages.metadata);
  assert.ok(stages.screenshot);
  for (const stage of [stages.metadata, stages.screenshot]) {
    const fields = (stage as { properties?: Record<string, unknown> }).properties!;
    for (const field of ["code", "message", "httpStatus", "contentType", "providerCode"]) assert.ok(field in fields, field);
  }
});

test("OpenAPI marks every write and session operation as authenticated", async () => {
  const doc = await document();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const requiresSession = path.startsWith("/previews/") ||
        ((method !== "get" || path.endsWith("/auth/session")) && !path.endsWith("/auth/email") &&
          !path.startsWith("/preview-images/") && !path.startsWith("/board-logos/") && !path.startsWith("/board-messages/"));
      assert.deepEqual(operation.security, requiresSession ? [{ bearerAuth: [] }] : [], `${method} ${path}`);
    }
  }
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
