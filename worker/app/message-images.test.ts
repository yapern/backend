import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./router";
import { MAX_IMAGE_BYTES } from "./board-images";
import { createTestDatabase } from "../testing/database";

const origin = "https://api.yapern.com";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const image = (bytes: Uint8Array = png, type = "image/png") => new File([bytes as BlobPart], "photo.png", { type });
type Message = { id: string; user_id: string; board_id: string; title: string; body: string; image_url: string | null };

async function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const objects = new Map<string, { bytes: Uint8Array; options: R2PutOptions }>();
  const storage = { failPut: false, failDelete: false };
  const env = { DB: database.db, BUCKET: {
    async put(key: string, bytes: Uint8Array, options: R2PutOptions) {
      objects.set(key, { bytes: bytes.slice(), options });
      if (storage.failPut) throw new Error("Upload acknowledgement lost");
    },
    async delete(key: string) {
      if (storage.failDelete) throw new Error("Storage unavailable");
      objects.delete(key);
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { body: new Response(object.bytes as BodyInit).body, size: object.bytes.length, httpEtag: '"image-etag"' } : null;
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.length, httpEtag: '"image-etag"' } : null;
    },
  } } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) => handleRequest(new Request(`${origin}${path}`, init), env);
  const signedIn = await request("/auth/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "image-author@example.com", password: "correct horse battery" }),
  });
  const owner = await signedIn.json() as { token: string; user: { id: string } };
  const upload = (entries: [string, string | File][] = [["image", image()], ["body", "  First\n\nLast  "]], token = owner.token) => {
    const form = new FormData();
    form.set("board_id", "general");
    form.set("title", "  Photo  ");
    for (const [key, value] of entries) form.append(key, value);
    return request("/tables/messages", {
      method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://yapern.com" }, body: form,
    });
  };
  const remove = (id: string) => request(`/tables/messages?id=eq.${id}`, {
    method: "DELETE", headers: { authorization: `Bearer ${owner.token}` },
  });
  return { database, env, objects, storage, request, owner, upload, remove };
}

async function saved(response: Response): Promise<Message> {
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { data: Message[] }).data[0];
}

test("message images use the root board-messages folder, render via public URLs, and clean up on deletion", async t => {
  const api = await fixture(t);
  const message = await saved(await api.upload());
  assert.equal(message.title, "Photo");
  assert.equal(message.user_id, api.owner.user.id);
  assert.match(message.image_url!, /^\/board-messages\/[0-9a-f-]{36}\.png$/);
  assert.equal(message.body, `${origin}${message.image_url}\nFirst\n\nLast`);
  const stored = api.objects.get(message.image_url!.slice(1))!;
  assert.deepEqual(stored.bytes, new Uint8Array(png));
  assert.deepEqual(stored.options.httpMetadata, { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" });
  const get = await api.request(message.image_url!);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/png");
  assert.equal(get.headers.get("access-control-allow-origin"), "*");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
  const head = await api.request(message.image_url!, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(png.length));
  assert.equal(await head.text(), "");
  assert.equal((await api.remove(message.id)).status, 200);
  assert.equal(api.objects.size, 0);
  assert.equal((await api.request(message.image_url!)).status, 404);
});

test("image-only posts and all four formats work, including the exact size and final body limits", async t => {
  const api = await fixture(t);
  const files = [image(), image(Uint8Array.of(255, 216, 255), "image/jpeg"),
    image(Buffer.from("GIF89a"), "image/gif"), image(Buffer.from("RIFF0000WEBP"), "image/webp")];
  for (const file of files) {
    const message = await saved(await api.upload([["image", file]]));
    assert.equal(message.body, `${origin}${message.image_url}`);
  }
  const bytes = new Uint8Array(MAX_IMAGE_BYTES); bytes.set(png);
  await saved(await api.upload([["image", image(bytes)]]));
  const urlLength = `${origin}/board-messages/00000000-0000-0000-0000-000000000000.png\n`.length;
  const text = "a".repeat(2000 - urlLength - 2) + "\nb";
  assert.equal((await saved(await api.upload([["image", image()], ["body", text]]))).body.length, 2000);
  const previous = api.objects.size;
  assert.equal((await api.upload([["image", image()], ["body", `${text}c`]])).status, 400);
  assert.equal(api.objects.size, previous);
});

test("invalid sessions, fields, origins, file signatures and sizes cannot create uploaded messages", async t => {
  const api = await fixture(t);
  assert.equal((await api.upload(undefined, "invalid")).status, 401);
  for (const [file, status] of [
    [image(new Uint8Array()), 415], [image(Buffer.from("not a PNG")), 415],
    [image(png, "image/jpeg"), 415], [image(png, "image/svg+xml"), 415],
    [image(new Uint8Array(MAX_IMAGE_BYTES + 1)), 413],
    [image(new Uint8Array(MAX_IMAGE_BYTES + 16 * 1024)), 413],
  ] as const) assert.equal((await api.upload([["image", file]])).status, status);
  for (const fields of [
    [["body", "No image"]], [["image", image()], ["image", image()]],
    [["image", image()], ["image_url", "/board-messages/forged.png"]],
    [["image", image()], ["body", "a".repeat(2001)]],
  ] as [string, string | File][][]) assert.equal((await api.upload(fields)).status, 400);
  const form = new FormData(); form.set("image", image()); form.set("board_id", "missing"); form.set("title", "Photo");
  assert.equal((await api.request("/tables/messages", { method: "POST", headers: { authorization: `Bearer ${api.owner.token}` }, body: form })).status, 404);
  assert.equal((await api.request("/tables/messages", { method: "POST", headers: {
    origin: "https://other.example", authorization: `Bearer ${api.owner.token}`,
  }, body: form })).status, 403);
  assert.equal(api.objects.size, 0);
});

test("failed uploads and database writes clean up, and missing storage does not create a post", async t => {
  t.mock.method(console, "error", () => {});
  const api = await fixture(t);
  const bucket = api.env.BUCKET;
  api.env.BUCKET = undefined as unknown as R2Bucket;
  assert.equal((await api.upload()).status, 503);
  api.env.BUCKET = bucket;
  api.storage.failPut = true;
  assert.equal((await api.upload()).status, 500);
  assert.equal(api.objects.size, 0);
  api.storage.failPut = false;
  api.database.sqlite.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.equal((await api.upload()).status, 500);
  assert.equal(api.objects.size, 0);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM messages").get()!.n, 0);
});

test("copying a public image URL never grants cleanup rights, and cleanup failures do not undo deletion", async t => {
  t.mock.method(console, "error", () => {});
  const api = await fixture(t);
  const original = await saved(await api.upload());
  const copied = await saved(await api.request("/tables/messages", {
    method: "POST", headers: { authorization: `Bearer ${api.owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ board_id: "general", title: "Copied link", body: original.body }),
  }));
  assert.equal(copied.image_url, null);
  assert.equal((await api.remove(copied.id)).status, 200);
  assert.equal(api.objects.size, 1);
  api.storage.failDelete = true;
  assert.equal((await api.remove(original.id)).status, 200);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM messages").get()!.n, 0);
});
