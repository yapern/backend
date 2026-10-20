import { z } from "@hono/zod-openapi";
import { requireSession } from "./auth";
import { ApiError, protectedSecurity } from "./contracts";
import { publishNotifications } from "./notifications";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";

const id = z.string().min(1).max(512);
const vote = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const Vote = z.object({
  id, type: z.enum(["message", "reply"]), score: z.number().int(), user_vote: vote,
}).openapi("VoteSummary");
const VoteResult = z.object({ data: z.array(Vote) }).openapi("VoteResults");
const VoteInput = z.union([
  z.object({ message_id: id, value: vote }).strict(),
  z.object({ reply_id: id, value: vote }).strict(),
]).openapi("SetVote");

type VoteRow = { id: string; score: number; user_vote: number };
type VoteSummary = z.infer<typeof Vote>;

function ids(value: string | undefined): string[] {
  if (value === undefined) return [];
  const parsed = value.split(",");
  if (parsed.length > 100 || parsed.some(item => !id.safeParse(item).success) ||
      new Set(parsed).size !== parsed.length) throw new ApiError(400, "invalid_request");
  return parsed;
}

async function readVotes(db: D1Database, type: "message" | "reply", targetIds: string[], userId: string | null): Promise<VoteSummary[]> {
  if (!targetIds.length) return [];
  const table = type === "message" ? "messages" : "replies";
  const votes = type === "message" ? "message_votes" : "reply_votes";
  const key = type === "message" ? "message_id" : "reply_id";
  const byId = new Map<string, VoteRow>();
  // D1 permits at most 100 bound parameters in one statement. The viewer ID
  // consumes one, leaving room for 99 target IDs per query.
  for (let start = 0; start < targetIds.length; start += 99) {
    const chunk = targetIds.slice(start, start + 99);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db.prepare(`SELECT t.id, COALESCE(SUM(v.value),0) AS score,
      COALESCE(MAX(CASE WHEN v.user_id=? THEN v.value END),0) AS user_vote
      FROM ${table} t LEFT JOIN ${votes} v ON v.${key}=t.id
      WHERE t.id IN (${placeholders}) GROUP BY t.id`)
      .bind(userId, ...chunk).all<VoteRow>();
    for (const row of result.results) byId.set(row.id, row);
  }
  return targetIds.flatMap(targetId => {
    const row = byId.get(targetId);
    return row ? [{ id: row.id, type, score: row.score, user_vote: row.user_vote as -1 | 0 | 1 }] : [];
  });
}

export function registerVoteRoutes(app: Api): void {
  registerRoute(app, {
    method: "get", path: "/votes", operationId: "getVotes", tags: ["Votes"],
    summary: "Read message and reply vote scores and your contributions",
    description: "Request up to 100 comma-separated IDs of each type. Anonymous readers receive user_vote 0. Missing targets are omitted.",
    security: [], request: { query: z.object({ message_ids: z.string().optional(), reply_ids: z.string().optional() }).strict() },
    responses: { 200: jsonResult(VoteResult, "Vote summaries in requested order."),
      400: errorResult("Invalid ID list."), 401: errorResult("Invalid bearer session.") },
  }, async c => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(key => !["message_ids", "reply_ids"].includes(key)) ||
        params.getAll("message_ids").length > 1 || params.getAll("reply_ids").length > 1) {
      throw new ApiError(400, "invalid_request");
    }
    const messageIds = ids(params.get("message_ids") ?? undefined);
    const replyIds = ids(params.get("reply_ids") ?? undefined);
    if (!messageIds.length && !replyIds.length) throw new ApiError(400, "invalid_request");
    const userId = c.req.header("authorization")
      ? (await requireSession(c.req.raw, c.env)).user_id : null;
    const data = [
      ...await readVotes(c.env.DB, "message", messageIds, userId),
      ...await readVotes(c.env.DB, "reply", replyIds, userId),
    ];
    return c.json({ data });
  });

  registerRoute(app, {
    method: "put", path: "/votes", operationId: "setVote", tags: ["Votes"],
    summary: "Set your contribution to one message or reply",
    description: "A new post starts with its author's +1 vote. Setting the same value again is idempotent. Switch between +1 and -1 through 0.",
    security: protectedSecurity,
    request: { body: { required: true, content: jsonContent(VoteInput) } },
    responses: {
      200: jsonResult(VoteResult, "The updated score and your contribution."),
      400: errorResult("Invalid vote request."),
      401: errorResult("A valid bearer session is required."),
      404: errorResult("The message or reply does not exist."),
      409: errorResult("Set vote to zero before switching direction (invalid_vote_transition)."),
    },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const input = VoteInput.parse(await c.req.json());
    const type = "message_id" in input ? "message" : "reply";
    const targetId = "message_id" in input ? input.message_id : input.reply_id;
    const table = type === "message" ? "messages" : "replies";
    const votes = type === "message" ? "message_votes" : "reply_votes";
    const key = type === "message" ? "message_id" : "reply_id";
    const changed = await c.env.DB.prepare(`INSERT INTO ${votes}(${key},user_id,value)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ${table} WHERE id=?)
      ON CONFLICT(${key},user_id) DO UPDATE SET value=excluded.value
      WHERE ${votes}.value<>excluded.value
        AND (${votes}.value=0 OR excluded.value=0)
      RETURNING value`)
      .bind(targetId, session.user_id, input.value, targetId).first<{ value: number }>();
    if (!changed) {
      const existing = await c.env.DB.prepare(`SELECT v.value FROM ${table} t
        LEFT JOIN ${votes} v ON v.${key}=t.id AND v.user_id=? WHERE t.id=?`)
        .bind(session.user_id, targetId).first<{ value: number | null }>();
      if (!existing) throw new ApiError(404, "not_found");
      if (existing.value !== input.value) throw new ApiError(409, "invalid_vote_transition");
    }
    const [summary] = await readVotes(c.env.DB, type, [targetId], session.user_id);
    if (!summary) throw new ApiError(404, "not_found");
    if (changed && input.value === 1) {
      // The trigger committed the outbox row with the vote. Delivery is best
      // effort and never changes the outcome of a successful vote.
      try {
        const recipient = await c.env.DB.prepare(`SELECT user_id FROM ${table} WHERE id=?`)
          .bind(targetId).first<{ user_id: string }>();
        if (recipient && recipient.user_id !== session.user_id) {
          await publishNotifications(c.env, recipient.user_id);
        }
      } catch (error) {
        console.error("notification_delivery_pending", { targetId, error });
      }
    }
    return c.json({ data: [summary] });
  });
}
