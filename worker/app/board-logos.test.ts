import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./router";
import { MAX_LOGO_BYTES } from "./board-logos";
import { createTestDatabase } from "../testing/database";

const origin = "https://api.yapern.com";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"));
const image = (bytes = png, type = "image/png") => new File([bytes], "logo.png", { type });
type Board = { id: string; user_id: string; name: string; slug: string; description: string; logo_url: string | null };

async function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const objects = new Map<string, { bytes: Uint8Array; options: R2PutOptions }>();
  const deleted: string[] = [];
  const storage = { failPut: false, failDelete: false, beforePut: undefined as (() => void) | undefined };
  const env = { DB: database.db, BUCKET: {
    async put(key: string, bytes: Uint8Array, options: R2PutOptions) {
      storage.beforePut?.();
      objects.set(key, { bytes: bytes.slice(), options });
      if (storage.failPut) throw new Error("R2 acknowledgement lost");
    },
    async delete(key: string) {
      deleted.push(key);
      if (storage.failDelete) throw new Error("R2 unavailable");
      objects.delete(key);
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { body: new Response(object.bytes as BodyInit).body, size: object.bytes.length, httpEtag: '"logo-etag"' } : null;
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.length, httpEtag: '"logo-etag"' } : null;
    },
  } } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) => handleRequest(new Request(`${origin}${path}`, init), env);
  const signIn = async (email: string) => {
    const response = await request("/auth/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery" }),
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ token: string; user: { id: string } }>;
  };
  const owner = await signIn("logo-owner@example.com");
  const created = await request("/tables/boards", {
    method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug: "logo-board", name: "Logo Board", description: "Original" }),
  });
  const board = ((await created.json()) as { data: Board[] }).data[0];
  const path = `/tables/boards?id=eq.${board.id}&user_id=eq.${owner.user.id}`;
  const upload = (file = image(), description = "Updated", token = owner.token, customPath = path) => {
    const body = new FormData();
    body.set("description", description);
    body.set("logo", file);
    return request(customPath, { method: "PATCH", headers: { authorization: `Bearer ${token}`, origin: "https://yapern.com" }, body });
  };
  const patch = (input: unknown) => request(path, {
    method: "PATCH", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const read = () => ({ ...database.sqlite.prepare("SELECT * FROM boards WHERE id=?").get(board.id) }) as Board;
  return { database, env, request, signIn, owner, board, path, upload, patch, read, objects, deleted, storage };
}

async function saved(response: Response): Promise<Board> {
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { data: Board[] }).data[0];
}

test("logos persist with descriptions, serve publicly, and clean up on replacement and removal", async t => {
  const api = await fixture(t);
  assert.equal(api.board.logo_url, null);
  const uploaded = await saved(await api.upload());
  assert.equal(uploaded.description, "Updated");
  assert.equal(uploaded.id, api.board.id);
  assert.equal(uploaded.name, api.board.name);
  assert.match(uploaded.logo_url!, /^\/board-logos\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(api.read(), uploaded);
  const key = uploaded.logo_url!.slice(1);
  assert.deepEqual(api.objects.get(key)?.bytes, png);
  assert.deepEqual(api.objects.get(key)?.options.httpMetadata, {
    contentType: "image/png", cacheControl: "public, max-age=31536000, immutable",
  });
  const read = await api.request(`/tables/boards?id=eq.${api.board.id}&select=id,logo_url`);
  assert.deepEqual(await read.json(), { data: [{ id: api.board.id, logo_url: uploaded.logo_url }] });
  const get = await api.request(uploaded.logo_url!);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/png");
  assert.equal(get.headers.get("content-length"), String(png.length));
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.equal(get.headers.get("access-control-allow-origin"), "*");
  assert.equal(get.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), png);
  const head = await api.request(uploaded.logo_url!, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(png.length));
  assert.equal(await head.text(), "");
  assert.equal((await saved(await api.patch({ description: "Only description" }))).logo_url, uploaded.logo_url);
  const replaced = await saved(await api.upload(image(), "Replaced"));
  assert.notEqual(replaced.logo_url, uploaded.logo_url);
  assert.deepEqual(api.deleted, [key]);
  assert.equal(api.objects.size, 1);
  assert.equal((await api.request(uploaded.logo_url!)).status, 404);
  const removed = await saved(await api.patch({ description: "Removed", remove_logo: true }));
  assert.equal(removed.logo_url, null);
  assert.equal(removed.description, "Removed");
  assert.equal(api.objects.size, 0);
  assert.deepEqual(api.deleted, [key, replaced.logo_url!.slice(1)]);
  assert.equal((await saved(await api.patch({ description: "Removed", remove_logo: true }))).logo_url, null);
});

test("logo writes enforce session, ownership, exact board identity, and allowed origins", async t => {
  const api = await fixture(t);
  const other = await api.signIn("logo-other@example.com");
  assert.equal((await api.upload(image(), "Stolen", "invalid-token")).status, 401);
  assert.equal((await api.upload(image(), "Stolen", other.token)).status, 403);
  assert.equal((await api.upload(image(), "Stolen", other.token, `/tables/boards?id=eq.${api.board.id}`)).status, 403);
  assert.equal((await api.upload(image(), "Stolen", api.owner.token, "/tables/boards?id=eq.general")).status, 403);
  assert.equal((await api.upload(image(), "Missing", api.owner.token, "/tables/boards?id=eq.missing")).status, 404);
  const form = new FormData(); form.set("description", "No"); form.set("logo", image());
  const denied = await api.request(api.path, { method: "PATCH", headers: { origin: "https://other.example", authorization: `Bearer ${api.owner.token}` }, body: form });
  assert.equal(denied.status, 403);
  assert.equal(api.objects.size, 0);
  assert.deepEqual(api.read(), api.board);
});

test("all supported image formats and the exact 5 MiB boundary are accepted with canonical filenames", async t => {
  const api = await fixture(t);
  const boundary = new Uint8Array(MAX_LOGO_BYTES);
  boundary.set(png);
  assert.match((await saved(await api.upload(image(boundary)))).logo_url!, /\.png$/);
  for (const [type, extension, signature] of [
    ["image/jpeg", "jpg", [255, 216, 255, 224]],
    ["image/gif", "gif", [71, 73, 70, 56, 57, 97]],
    ["image/webp", "webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
  ] as const) {
    const board = await saved(await api.upload(image(Uint8Array.from(signature), type)));
    assert.ok(board.logo_url?.endsWith(`.${extension}`));
    assert.equal((await api.request(board.logo_url!)).headers.get("content-type"), type);
  }
  assert.equal(api.objects.size, 1);
});

test("uploads reject spoofed types, unsupported images, empty or oversized files, and invalid fields", async t => {
  const api = await fixture(t);
  for (const file of [image(new Uint8Array(), "image/png"), image(new TextEncoder().encode("<svg/>"), "image/png"), image(png, "image/jpeg"), image(png, "image/svg+xml")]) {
    assert.equal((await api.upload(file)).status, 415);
  }
  assert.equal((await api.upload(image(new Uint8Array(MAX_LOGO_BYTES + 1)))).status, 413);
  assert.equal((await api.upload(image(new Uint8Array(MAX_LOGO_BYTES + 16 * 1024)))).status, 413);
  assert.equal((await api.upload(image(), "a".repeat(2001))).status, 400);
  for (const entries of [
    [["description", "Okay"], ["logo", image()], ["logo", image()]],
    [["description", "Okay"], ["logo", image()], ["user_id", "someone"]],
    [["description", "Okay"], ["logo", image()], ["remove_logo", "true"]],
    [["description", "Okay"]], [["logo", image()]],
  ]) {
    const form = new FormData();
    for (const [key, value] of entries) form.append(key as string, value);
    const result = await api.request(api.path, { method: "PATCH", headers: { authorization: `Bearer ${api.owner.token}` }, body: form });
    assert.equal(result.status, 400, await result.clone().text());
  }
  assert.equal((await api.patch({ description: "No", logo_url: "/previews/other" })).status, 400);
  assert.equal(api.objects.size, 0);
  assert.deepEqual(api.read(), api.board);
});

test("upload and database failures preserve the saved logo and remove uncommitted objects", async t => {
  t.mock.method(console, "error", () => {});
  const api = await fixture(t);
  const first = await saved(await api.upload());
  api.storage.failPut = true;
  assert.equal((await api.upload()).status, 500);
  assert.deepEqual(api.read(), first);
  assert.deepEqual([...api.objects.keys()], [first.logo_url!.slice(1)]);
  api.storage.failPut = false;
  api.database.sqlite.exec("CREATE TRIGGER reject_board_update BEFORE UPDATE ON boards BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.equal((await api.upload(image(), "Failed description")).status, 500);
  assert.deepEqual(api.read(), first);
  assert.deepEqual([...api.objects.keys()], [first.logo_url!.slice(1)]);
});

test("a concurrent logo change wins and the losing upload is cleaned up", async t => {
  const api = await fixture(t);
  const first = await saved(await api.upload());
  api.storage.beforePut = () => {
    api.database.sqlite.prepare("UPDATE boards SET logo_url=NULL,description='Concurrent edit' WHERE id=?").run(api.board.id);
  };
  const response = await api.upload(image(), "Stale edit");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "board_changed" });
  assert.equal(api.read().logo_url, null);
  assert.equal(api.read().description, "Concurrent edit");
  assert.deepEqual([...api.objects.keys()], [first.logo_url!.slice(1)]);
});

test("missing logo storage preserves board data, and a cleanup failure does not report a committed save as failed", async t => {
  t.mock.method(console, "error", () => {});
  const api = await fixture(t);
  const bucket = api.env.BUCKET;
  api.env.BUCKET = undefined as unknown as R2Bucket;
  assert.equal((await api.upload()).status, 503);
  assert.deepEqual(api.read(), api.board);
  api.env.BUCKET = bucket;
  await saved(await api.upload());
  api.storage.failDelete = true;
  const removed = await saved(await api.patch({ description: "Removed", remove_logo: true }));
  assert.equal(removed.logo_url, null);
  assert.deepEqual(api.read(), removed);
});
