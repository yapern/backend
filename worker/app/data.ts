import { z } from "@hono/zod-openapi";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";
import { requireSession } from "./auth";
import { ApiError, protectedSecurity } from "./contracts";
import { deleteBoardLogo, storeBoardLogo } from "./board-logos";
import { deleteBoardImage, storeBoardImage } from "./board-images";
import { notifyReply, publishNotifications } from "./notifications";
import { createVideoMessage, deleteVideoAsset, MessageVideo, messageVideos } from "./message-videos";

const identifier = z.string().trim().min(1).max(512);
const name = z.string().trim().min(1).max(80);
const body = z.string().trim().min(1).max(2000);
const messageBody = z.string().overwrite(value => value.replace(/\r\n?/g, "\n").trim());
const boardDescription = z.string().overwrite(value => value.replace(/\r\n?/g, "\n").trim()).max(2000);
const filter = z.string().min(4).max(515).startsWith("eq.");
const pagination = {
  select: z.string().max(256).optional(),
  order: z.string().max(256).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).default("20"),
  offset: z.string().regex(/^(?:0|[1-9][0-9]{0,8})$/).default("0"),
};

const Profile = z.object({ id: z.string(), name: z.string() }).openapi("PublicProfile");
const Board = z.object({
  id: z.string(), slug: z.string(), name: z.string(), description: z.string(),
  created_at: z.string(), user_id: z.string().nullable(), logo_url: z.string().nullable(),
}).openapi("Board");
const Message = z.object({
  id: z.string(), board_id: z.string(), user_id: z.string(), title: z.string(),
  body: z.string(), created_at: z.string(), image_url: z.string().nullable(),
  video: MessageVideo.nullable().optional(),
  reply_count: z.number().int().nonnegative().openapi({ description: "Stored reply total, maintained atomically by database triggers." }),
}).openapi("Message");
export const Reply = z.object({
  id: z.string(), message_id: z.string(), user_id: z.string(), body: z.string(), created_at: z.string(),
  parent_reply_id: z.string().nullable().openapi({ description: "Immediate parent reply, or null for a direct reply to the root message." }),
  direct_reply_count: z.number().int().nonnegative().openapi({ description: "Stored immediate-child reply count, maintained atomically by database triggers." }),
}).openapi("Reply");

const boardQuery = z.object({ ...pagination, id: filter.optional(), slug: filter.optional(), user_id: filter.optional() }).strict();
const messageQuery = z.object({ ...pagination, id: filter.optional(), board_id: filter.optional(), user_id: filter.optional() }).strict();
const replyQuery = z.object({ ...pagination, id: filter.optional(), message_id: filter.optional(), user_id: filter.optional() }).strict();
const profileQuery = z.object({ ...pagination, id: filter.optional() }).strict();

const ownerInput = { user_id: identifier.optional() };
const boardInput = z.object({
  ...ownerInput,
  slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/),
  name, description: boardDescription.default(""),
}).strict().openapi("CreateBoard");
const messageInput = z.object({
  ...ownerInput, board_id: identifier, title: z.string().trim().min(1).max(200), body: messageBody.min(1).max(2000),
}).strict().openapi("CreateMessage");
const messageImageInput = messageInput.extend({
  body: messageBody.max(2000).default(""),
  image: z.instanceof(File).openapi({ type: "string", format: "binary" }),
}).openapi("CreateMessageImage");
const messageVideoInput = messageInput.extend({
  body: messageBody.max(2000).default(""), attachment_id: z.uuid(),
}).openapi("CreateMessageVideo");
const replyInput = z.object({
  ...ownerInput, message_id: identifier, body, parent_reply_id: identifier.nullable().optional(),
}).strict().openapi("CreateReply");
const replyHeaders = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional(),
});
const profileInput = z.object({ name }).strict().openapi("UpdateProfile");
const boardUpdateInput = z.object({
  description: boardDescription, remove_logo: z.boolean().optional(),
}).strict().openapi("UpdateBoardDescription");
const boardLogoInput = z.object({
  description: boardDescription,
  logo: z.instanceof(File).openapi({ type: "string", format: "binary" }),
}).strict().openapi("UpdateBoardLogo");
const boardUpdateQuery = z.object({ id: filter, user_id: filter.optional() }).strict();
const profileFilter = z.object({ id: filter }).strict();
const deleteQuery = z.object({ id: filter, board_id: filter.optional(), user_id: filter.optional() }).strict();

const rows = (schema: z.ZodType) => z.object({ data: z.array(schema) });
const writeErrors = {
  400: errorResult("Invalid request or unsupported fields (invalid_request)."),
  401: errorResult("A valid, unexpired bearer session is required (unauthorized)."),
  403: errorResult("The authenticated user does not own this record (permission_denied)."),
  404: errorResult("The requested record does not exist (not_found)."),
};

type Collection = {
  table: "boards" | "messages" | "replies" | "users";
  fields: readonly string[];
  filters: readonly string[];
  query: z.ZodType;
  schema: z.ZodObject;
  tag: string;
  order: string;
};

// Each resource defines its public fields explicitly. Client input never becomes
// a table, column, operator, or SQL expression without an allowlist check.
const collections: Collection[] = [
  { table: "boards", fields: ["id", "slug", "name", "description", "created_at", "user_id", "logo_url"], filters: ["id", "slug", "user_id"], query: boardQuery, schema: Board, tag: "Boards", order: "slug.asc" },
  { table: "messages", fields: ["id", "board_id", "user_id", "title", "body", "created_at", "image_url", "reply_count", "video"], filters: ["id", "board_id", "user_id"], query: messageQuery, schema: Message, tag: "Messages", order: "created_at.desc" },
  { table: "replies", fields: ["id", "message_id", "user_id", "body", "created_at", "parent_reply_id", "direct_reply_count"], filters: ["id", "message_id", "user_id"], query: replyQuery, schema: Reply, tag: "Replies", order: "created_at.asc" },
  { table: "users", fields: ["id", "name"], filters: ["id"], query: profileQuery, schema: Profile, tag: "Profiles", order: "id.asc" },
];

function queryValues(url: string): Record<string, string> {
  const params = new URL(url).searchParams;
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new ApiError(400, "invalid_request");
    result[key] = value;
  }
  return result;
}

function equality(value: string): string {
  const result = value.slice(3);
  if (!result.trim()) throw new ApiError(400, "invalid_request");
  return result;
}

function selectFields(value: string | undefined, allowed: readonly string[]): string {
  if (value === undefined) return allowed.join(",");
  const fields = value.split(",");
  if (!fields.length || new Set(fields).size !== fields.length || fields.some(field => !allowed.includes(field))) {
    throw new ApiError(400, "invalid_request");
  }
  return fields.join(",");
}

function orderFields(value: string, collection: Collection): string {
  const allowed = collection.fields.filter(field => field !== "video");
  if (collection.table === "messages") allowed.push("votes");
  const clauses = value.split(",");
  const fields: string[] = [];
  const ordered = clauses.map(clause => {
    const [field, direction, extra] = clause.split(".");
    if (!allowed.includes(field) || !["asc", "desc"].includes(direction) || extra !== undefined || fields.includes(field)) {
      throw new ApiError(400, "invalid_request");
    }
    fields.push(field);
    const column = field === "votes"
      ? "(SELECT COALESCE(SUM(value),0) FROM message_votes WHERE message_id=messages.id)"
      : field;
    return `${column} ${direction.toUpperCase()}`;
  });
  // Stable ordering prevents rows shifting between pages with equal sort values.
  if (!fields.includes("id")) ordered.push("id ASC");
  return ordered.join(",");
}

function checkOwner(supplied: string | undefined, actual: string): void {
  if (supplied !== undefined && supplied !== actual) throw new ApiError(403, "permission_denied");
}

export function registerDataRoutes(app: Api): void {
  for (const collection of collections) {
    registerRoute(app, {
      method: "get", path: `/tables/${collection.table}`,
      operationId: `list${collection.tag}`, tags: [collection.tag],
      summary: `Read ${collection.table === "users" ? "public author profiles" : collection.table}`,
      description: "Supports allowlisted select fields, eq. filters, field.asc/field.desc ordering, and limit/offset pagination (maximum 100). Profiles expose only id and name. The legacy apikey header is accepted but grants no permissions." +
        (collection.table === "messages" ? " Messages also support votes.asc/votes.desc to sort by total vote score before pagination; use votes.desc,created_at.desc for newest-first ties." : ""),
      security: [], request: { query: collection.query as z.ZodObject },
      responses: {
        200: jsonResult(rows(collection.schema.partial()), "Matching records in the data array. A select projection may omit fields."),
        400: errorResult("Unsupported query, projection, filter, or sort field (invalid_request)."),
      },
    }, async c => {
      const query = collection.query.parse(queryValues(c.req.url)) as Record<string, string | undefined>;
      const selected = selectFields(query.select, collection.fields).split(",");
      const withVideo = collection.table === "messages" && selected.includes("video");
      const fields = selected.map(field => field === "video" ? "id AS __video_message_id" : field).join(",");
      const order = orderFields(query.order ?? collection.order, collection);
      const conditions: string[] = [];
      const parameters: (string | number)[] = [];
      for (const column of collection.filters) {
        if (query[column] !== undefined) {
          conditions.push(`${column}=?`);
          parameters.push(equality(query[column]!));
        }
      }
      parameters.push(Number(query.limit), Number(query.offset));
      const result = await c.env.DB.prepare(`SELECT ${fields} FROM ${collection.table}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .bind(...parameters).all();
      if (!withVideo) return c.json({ data: result.results });
      const videos = await messageVideos(c.env, result.results.map(row => String(row.__video_message_id)));
      return c.json({ data: result.results.map(({ __video_message_id, ...row }) => ({ ...row, video: videos.get(String(__video_message_id)) ?? null })) });
    });
  }

  registerRoute(app, {
    method: "post", path: "/tables/boards", operationId: "createBoard",
    tags: ["Boards"], summary: "Create a board owned by the signed-in user", security: protectedSecurity,
    request: { body: { required: true, content: jsonContent(boardInput) } },
    responses: { ...writeErrors, 201: jsonResult(rows(Board), "Created board."), 409: errorResult("This slug is already in use (board_exists).") },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const input = boardInput.parse(await c.req.json());
    checkOwner(input.user_id, session.user_id);
    const result = await c.env.DB.prepare("INSERT INTO boards(slug,name,description,user_id) VALUES(?,?,?,?) ON CONFLICT(slug) DO NOTHING RETURNING *")
      .bind(input.slug, input.name, input.description, session.user_id).first();
    if (!result) throw new ApiError(409, "board_exists");
    return c.json({ data: [result] }, 201);
  });

  registerRoute(app, {
    method: "patch", path: "/tables/boards", operationId: "updateBoardDescription",
    tags: ["Boards"], summary: "Update the description or logo of a board you created", security: protectedSecurity,
    description: "Send JSON with description and optional remove_logo, or multipart/form-data with description and a logo file (PNG, JPEG, GIF, or WebP, at most 5 MiB). Replacements and removals delete the previous object from R2.",
    // Hono treats required bodies as requiring every declared media type.
    // Validate the selected format here and require its fields in the handler.
    request: { query: boardUpdateQuery, body: { content: {
      ...jsonContent(boardUpdateInput), "multipart/form-data": { schema: boardLogoInput },
    } } },
    responses: {
      ...writeErrors, 200: jsonResult(rows(Board), "Updated board. Its name, slug, and creator are unchanged."),
      409: errorResult("The logo changed during this request. Reload before saving again (board_changed)."),
      413: errorResult("The logo exceeds 5 MiB (request_too_large)."),
      415: errorResult("Unsupported file type or image signature (invalid_logo)."),
      503: errorResult("Logo storage is unavailable (logo_storage_unavailable)."),
    },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const query = boardUpdateQuery.parse(queryValues(c.req.url));
    if (query.user_id !== undefined) checkOwner(equality(query.user_id), session.user_id);
    const id = equality(query.id);
    const existing = await c.env.DB.prepare("SELECT user_id,logo_url FROM boards WHERE id=?")
      .bind(id).first<{ user_id: string | null; logo_url: string | null }>();
    if (!existing) throw new ApiError(404, "not_found");
    if (existing.user_id !== session.user_id) throw new ApiError(403, "permission_denied");
    const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
    let input: z.infer<typeof boardUpdateInput>;
    let file: File | undefined;
    if (contentType === "multipart/form-data") {
      const form = await c.req.formData();
      if ([...form.keys()].some(key => !["description", "logo"].includes(key) || form.getAll(key).length !== 1)) {
        throw new ApiError(400, "invalid_request");
      }
      const upload = boardLogoInput.parse(Object.fromEntries(form));
      input = { description: upload.description };
      file = upload.logo;
    } else if (contentType === "application/json") {
      input = boardUpdateInput.parse(await c.req.json());
    } else {
      throw new ApiError(415, "invalid_request");
    }
    if (file || input.remove_logo) {
      const logoUrl = file ? await storeBoardLogo(c.env, file) : null;
      let result;
      try {
        result = await c.env.DB.prepare("UPDATE boards SET description=?,logo_url=? WHERE id=? AND user_id=? AND logo_url IS ? RETURNING *")
          .bind(input.description, logoUrl, id, session.user_id, existing.logo_url).first();
        if (!result) throw new ApiError(409, "board_changed");
      } catch (error) {
        if (logoUrl) await deleteBoardLogo(c.env, logoUrl);
        throw error;
      }
      await deleteBoardLogo(c.env, existing.logo_url);
      return c.json({ data: [result] });
    }
    const result = await c.env.DB.prepare("UPDATE boards SET description=? WHERE id=? AND user_id=? RETURNING *")
      .bind(input.description, id, session.user_id).first();
    if (!result) throw new ApiError(404, "not_found");
    return c.json({ data: [result] });
  });

  registerRoute(app, {
    method: "post", path: "/tables/messages", operationId: "createMessage",
    tags: ["Messages"], summary: "Post a message to a board", security: protectedSecurity,
    description: "Send JSON for a text message, JSON with attachment_id for your completed Stream upload, or multipart/form-data with an image file (PNG, JPEG, GIF, or WebP, at most 5 MiB). Video uploads must belong to this user and board and be processing or ready. Media URLs are prepended to body for older clients; the final body must fit within 2000 characters. Retrying the same video and content returns its existing message.",
    request: { body: { content: {
      ...jsonContent(z.union([messageInput, messageVideoInput])), "multipart/form-data": { schema: messageImageInput },
    } } },
    responses: {
      ...writeErrors, 201: jsonResult(rows(Message), "Created message."),
      409: errorResult("The video is not ready, belongs to a different board/user, or has already been attached to different content."),
      413: errorResult("The image exceeds 5 MiB (request_too_large)."),
      415: errorResult("Unsupported file type or image signature (invalid_message_image)."),
      503: errorResult("Image storage is unavailable (image_storage_unavailable)."),
    },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
    let input: z.infer<typeof messageInput>;
    let file: File | undefined;
    if (contentType === "multipart/form-data") {
      const form = await c.req.formData();
      if ([...form.keys()].some(key => !["board_id", "user_id", "title", "body", "image"].includes(key) || form.getAll(key).length !== 1)) {
        throw new ApiError(400, "invalid_request");
      }
      const { image, ...values } = messageImageInput.parse(Object.fromEntries(form));
      input = values;
      file = image;
    } else if (contentType === "application/json") {
      const payload = await c.req.json();
      if (payload && typeof payload === "object" && Object.hasOwn(payload, "attachment_id")) {
        const videoInput = messageVideoInput.parse(payload);
        checkOwner(videoInput.user_id, session.user_id);
        return c.json({ data: [await createVideoMessage(c.env, session.user_id, videoInput)] }, 201);
      }
      input = messageInput.parse(payload);
    } else {
      throw new ApiError(415, "invalid_request");
    }
    checkOwner(input.user_id, session.user_id);
    if (file && !await c.env.DB.prepare("SELECT id FROM boards WHERE id=?").bind(input.board_id).first()) {
      throw new ApiError(404, "not_found");
    }
    const imageUrl = file ? await storeBoardImage(c.env, file, "board-messages") : null;
    try {
      const savedBody = messageBody.min(1).max(2000).parse(imageUrl
        ? `${new URL(imageUrl, c.req.url).href}${input.body ? `\n${input.body}` : ""}` : input.body);
      const result = await c.env.DB.prepare("INSERT INTO messages(board_id,user_id,title,body,image_url) SELECT id,?,?,?,? FROM boards WHERE id=? RETURNING *")
        .bind(session.user_id, input.title, savedBody, imageUrl, input.board_id).first();
      if (!result) throw new ApiError(404, "not_found");
      return c.json({ data: [result] }, 201);
    } catch (error) {
      await deleteBoardImage(c.env, imageUrl, "board-messages");
      throw error;
    }
  });

  registerRoute(app, {
    method: "post", path: "/tables/replies", operationId: "createReply",
    tags: ["Replies"], summary: "Reply to a message or another reply", security: protectedSecurity,
    description: "message_id always identifies the root message. Omit parent_reply_id (or send null) for a direct reply; otherwise provide an existing reply in that same message. Thread pointers are immutable and there is no application depth limit. direct_reply_count counts immediate children only. Optional Idempotency-Key (8–128 token characters) is scoped to the authenticated user; retry the same target and body with the same key to receive the original reply without duplicate votes, counters or notifications.",
    request: { headers: replyHeaders, body: { required: true, content: jsonContent(replyInput) } },
    responses: { ...writeErrors,
      201: jsonResult(rows(Reply), "Created reply, or the original reply for an identical idempotent retry."),
      409: errorResult("The idempotency key was already used for another body or target (idempotency_conflict)."),
    },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const input = replyInput.parse(await c.req.json());
    checkOwner(input.user_id, session.user_id);
    const parentId = input.parent_reply_id ?? null;
    const idempotencyKey = replyHeaders.parse({ "idempotency-key": c.req.header("idempotency-key") })["idempotency-key"] ?? null;
    // A single statement checks both targets and inserts, so deleting a parent
    // concurrently cannot leave an orphan or create a cross-message reply.
    const result = await c.env.DB.prepare(`INSERT INTO replies(message_id,user_id,body,parent_reply_id,idempotency_key)
      SELECT id,?,?,?,? FROM messages WHERE id=? AND (? IS NULL OR EXISTS (
        SELECT 1 FROM replies WHERE id=? AND message_id=messages.id
      )) ON CONFLICT(user_id,idempotency_key) DO NOTHING
      RETURNING id,message_id,user_id,body,created_at,parent_reply_id,direct_reply_count`)
      .bind(session.user_id, input.body, parentId, idempotencyKey, input.message_id, parentId, parentId).first<z.infer<typeof Reply>>();
    if (!result) {
      if (idempotencyKey) {
        const existing = await c.env.DB.prepare(`SELECT id,message_id,user_id,body,created_at,parent_reply_id,direct_reply_count
          FROM replies WHERE user_id=? AND idempotency_key=?`).bind(session.user_id, idempotencyKey).first<z.infer<typeof Reply>>();
        if (existing) {
          if (existing.message_id !== input.message_id || existing.parent_reply_id !== parentId || existing.body !== input.body) {
            throw new ApiError(409, "idempotency_conflict");
          }
          return c.json({ data: [existing] }, 201);
        }
      }
      throw new ApiError(404, "not_found");
    }
    await notifyReply(c.env, result.id);
    return c.json({ data: [result] }, 201);
  });

  registerRoute(app, {
    method: "patch", path: "/tables/users", operationId: "updateProfile",
    tags: ["Profiles"], summary: "Update your display name", security: protectedSecurity,
    request: { query: profileFilter, body: { required: true, content: jsonContent(profileInput) } },
    responses: { ...writeErrors, 200: jsonResult(rows(Profile), "Updated public profile.") },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const query = profileFilter.parse(queryValues(c.req.url));
    checkOwner(equality(query.id), session.user_id);
    const input = profileInput.parse(await c.req.json());
    const result = await c.env.DB.prepare("UPDATE users SET name=? WHERE id=? RETURNING id,name")
      .bind(input.name, session.user_id).first();
    if (!result) throw new ApiError(404, "not_found");
    return c.json({ data: [result] });
  });

  registerRoute(app, {
    method: "delete", path: "/tables/messages", operationId: "deleteMessage",
    tags: ["Messages"], summary: "Delete your message and its replies", security: protectedSecurity,
    request: { query: deleteQuery },
    responses: {
      ...writeErrors,
      200: jsonResult(z.object({ data: z.array(z.object({})).length(0), meta: z.object({ changes: z.literal(1) }) }), "Exactly one message was deleted; replies cascade automatically."),
    },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const query = deleteQuery.parse(queryValues(c.req.url));
    if (query.user_id !== undefined) checkOwner(equality(query.user_id), session.user_id);
    const id = equality(query.id);
    const existing = await c.env.DB.prepare(`SELECT board_id,user_id,image_url,
      (SELECT id FROM message_videos WHERE message_id=messages.id) AS video_id FROM messages WHERE id=?`)
      .bind(id).first<{ board_id: string; user_id: string; image_url: string | null; video_id: string | null }>();
    if (!existing || (query.board_id !== undefined && equality(query.board_id) !== existing.board_id)) throw new ApiError(404, "not_found");
    checkOwner(existing.user_id, session.user_id);
    // A reply author can receive an upvote on their reply. Deleting the parent
    // cascades that notification, so refresh every affected recipient's socket.
    const affected = await c.env.DB.prepare(`SELECT DISTINCT user_id FROM notifications
      WHERE message_id=? OR reply_id IN (SELECT id FROM replies WHERE message_id=?)`)
      .bind(id, id).all<{ user_id: string }>();
    // D1's changes metadata includes cascading replies. RETURNING confirms the
    // exact parent deletion independently of the number of replies removed.
    const result = await c.env.DB.prepare("DELETE FROM messages WHERE id=? AND user_id=? AND board_id=? RETURNING id")
      .bind(id, session.user_id, existing.board_id).first<{ id: string }>();
    if (!result) throw new ApiError(404, "not_found");
    await deleteBoardImage(c.env, existing.image_url, "board-messages");
    if (existing.video_id) await deleteVideoAsset(c.env, existing.video_id);
    for (const recipientId of new Set([existing.user_id, ...affected.results.map(row => row.user_id)])) {
      await publishNotifications(c.env, recipientId);
    }
    return c.json({ data: [], meta: { changes: 1 } });
  });
}
