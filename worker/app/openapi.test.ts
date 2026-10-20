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
    content: { "application/json": { schema: unknown } };
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
  const registered = app.routes.filter((route) => route.method !== "ALL"
    && !["/docs", "/docs/", "/openapi.json"].includes(route.path))
    .map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(documented, registered);
  assert.deepEqual(documented, ["GET /health", "GET /state"]);
  const ids = new Set<string>();
  for (const methods of Object.values(doc.paths)) {
    for (const operation of Object.values(methods)) {
      assert.ok(operation.summary);
      assert.ok(operation.operationId);
      assert.ok(!ids.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
      ids.add(operation.operationId);
      assert.ok(operation.responses["200"]?.content["application/json"].schema);
      for (const response of Object.values(operation.responses)) assert.ok(response.description);
      assert.deepEqual(operation.security, []);
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
  assert.deepEqual(Object.keys(doc.components.securitySchemes ?? {}), []);
  assert.deepEqual(Object.keys(doc.components.schemas).sort(), ["AppState", "Error", "Ok"]);
  assert.deepEqual(doc.tags, [{ name: "System" }]);
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
