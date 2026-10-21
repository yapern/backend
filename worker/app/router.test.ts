import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./router";

const origin = "https://api.yapern.com";

test("health returns an OK JSON response", async () => {
  const response = await handleRequest(new Request(`${origin}/health`), {} as Env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("unknown routes return not found", async () => {
  const response = await handleRequest(new Request(`${origin}/unknown`), {} as Env);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("state rejects non-GET requests", async () => {
  for (const method of ["HEAD", "POST", "DELETE"]) {
    const response = await handleRequest(new Request(`${origin}/state`, { method }), {} as Env);

    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET", method);
  }
});

test("state reports an unavailable Durable Object binding", async () => {
  const response = await handleRequest(new Request(`${origin}/state`), {} as Env);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "durable_object_unavailable" });
});

test("retired routes return not found", async (t) => {
  const retiredRoutes = [
    ["GET", "/iop/tracked-programs"],
    ["GET", "/directory/locations"],
    ["GET", "/map/tiles/1/2/3"],
    ["GET", "/reviews"],
    ["GET", "/tour-requests"],
    ["GET", "/directory/locations/example/herd"],
    ["GET", "/herds"],
    ["POST", "/iap/apple/notifications"],
    ["POST", "/auth/google"],
    ["GET", "/auth/me"],
    ["POST", "/auth/logout"],
    ["POST", "/auth/app/anonymous"],
    ["POST", "/auth/app/google"],
    ["POST", "/auth/app/email"],
    ["POST", "/auth/app/apple"],
    ["GET", "/auth/app/me"],
    ["DELETE", "/auth/app/me"],
    ["POST", "/auth/app/refresh"],
    ["POST", "/auth/app/logout"],
    ["POST", "/auth/app/legacy-exchange"],
    ["OPTIONS", "/auth/google"],
  ] as const;

  for (const [method, path] of retiredRoutes) {
    await t.test(`${method} ${path}`, async () => {
      const response = await handleRequest(new Request(`${origin}${path}`, { method }), {} as Env);

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
    });
  }
});
