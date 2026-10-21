# Yapern API

Run `npm install`, `npm run db:migrate:local`, and `npm run dev` to start the
Worker with a local D1 database. Run `npm test` and `npm run type-check` to verify
changes. Tests use isolated in-memory SQLite databases and require Node 22.13+.

Interactive API documentation is at `/docs`; the OpenAPI document is at
`/openapi.json`.

For the frontend cutover, set `apiOrigin` in `src/config.js` to
`https://api.yapern.com` (or the local Worker URL), use the routes below, and
send preview requests as `{ "url": "https://example.com" }`. Remove the old
`/bff/data/{projectId}` prefix from API paths. The legacy `apikey` header is
accepted for compatibility; bearer sessions authorize writes.

API routes:

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/auth/email` | Sign in, or create a new email account |
| GET | `/auth/session` | Read the signed-in session |
| DELETE | `/auth/session` | Revoke this session |
| GET | `/admin/users` | Admin-only safe user profiles, newest first |
| GET | `/admin/users/:userId` | Admin-only user profile detail |
| GET | `/admin/tables` | Admin-only catalog of available tables and columns |
| GET | `/admin/tables/:table` | Admin-only table search and pagination |
| GET | `/api/get-marketing-users` | Admin-only users who have not opted out of marketing |
| POST | `/api/send-marketing-email` | Admin-only marketing email sending |
| POST | `/api/unsubscribe` | Public permanent marketing email opt-out |
| GET / POST | `/unsubscribe` | Public email unsubscribe form and confirmation |
| GET | `/tables/boards` | Read boards |
| POST | `/tables/boards` | Create a board |
| PATCH | `/tables/boards` | Update the description and logo of a board you created |
| GET / HEAD | `/board-logos/:filename` | Read a public board logo from R2 |
| GET | `/tables/messages` | Read messages |
| POST | `/tables/messages` | Create a titled message |
| GET / HEAD | `/board-messages/:filename` | Read a public message image from R2 |
| DELETE | `/tables/messages` | Delete your message and its replies |
| GET | `/tables/replies` | Read replies |
| GET | `/messages/:messageId/replies` | Read one page of immediate reply children |
| GET | `/messages/:messageId/replies/:replyId/context` | Read bounded ancestry for a deep link |
| GET | `/search` | Full-text search over public messages or boards |
| POST | `/tables/replies` | Reply to a message or another reply |
| GET | `/votes` | Read scores and your votes for messages and replies |
| PUT | `/votes` | Set your vote on one message or reply |
| GET | `/notifications` | Read your latest 50 reply and upvote notifications and total unread count |
| POST | `/notifications/read` | Mark notifications through an observed ID as read |
| POST | `/notifications/ticket` | Create a single-use WebSocket ticket valid for 60 seconds |
| GET | `/notifications/socket` | Upgrade to a WebSocket using `user_id` and `ticket` query parameters |
| GET | `/tables/users` | Read public author IDs and display names |
| PATCH | `/tables/users` | Update your display name |
| POST | `/og-image` | Read link metadata or queue a screenshot |
| GET | `/previews/{id}` | Read your screenshot job status |
| GET, HEAD | `/preview-images/{id}.jpg` | Read a public cached screenshot |

## Admin and marketing email

Admin routes use Yapern's existing `Authorization: Bearer <token>` sessions and
require the current account email to be `oneone@gmail.com` (case-insensitive,
trimmed), matching Mainbrella's access policy. Sessions must be unexpired and
still belong to that address. Credentials, session tokens, and provider IDs are
excluded. The admin account must already have trusted, provisioned email
credentials: public signup cannot claim the reserved admin address because signup
does not verify email ownership. Existing admin credentials continue to work.
The available tables are `users`, `boards`, `messages`, and `replies`;
`/admin/tables/:table?q=<literal-substring>&offset=0` returns 25 rows and a
filtered total. These endpoints are read-only. Yapern has no billing subsystem,
so there are no balance or billing-history endpoints.

`GET /api/get-marketing-users?offset=0&limit=25` returns
`{ "users": [...], "total": 0, "offset": 0, "limit": 25 }`, with only `id`,
`email`, `name`, and `created_at` per user. Limits are 1–100 and offsets
0–1,000,000. Results exclude user-level and address-level opt-outs, including
other accounts sharing a normalized address. Like Mainbrella, null email
addresses remain in this list; skip them when preparing sends.

Apply `015_marketing_email_unsubscribe.sql` before deploying the new Worker.
`wrangler.jsonc` adds the `MARKETING_EMAIL` Email Sending binding. The sender's
domain must be onboarded with Cloudflare Email Sending before live sends work;
local Wrangler simulates sends. No email is sent by migrations or deployment.

Send one message with the admin bearer token, `Content-Type: application/json`,
and a trusted `Origin` such as `https://yapern.com`:

```json
{
  "to": "person@example.com",
  "from": "Yapern <hello@yapern.com>",
  "subj": "An update from Yapern",
  "message": "Your message here.\nLine breaks are preserved.",
  "fancy": true
}
```

`fancy` defaults to true for the Yapern template; false uses plain white HTML
with an unsubscribe footer. Messages are treated as plain text and HTML-escaped.
The JSON body limit is 1 MiB; message text is limited to 100,000 characters.
Success is `202 { "ok": true, "messageId": "..." }`, confirming provider
acceptance. This does not confirm inbox delivery. Sends are never retried
automatically. Unsubscribed recipients return 409 `recipient_unsubscribed`;
failed preference checks return 503 `email_preferences_unavailable` and prevent
sending. Provider rate limits return 429; other send failures return 502.

Both HTML and text include a link to
`https://api.yapern.com/unsubscribe?email=<encoded-address>`. The public page
requires a form submission, works without JavaScript, and changes no preferences
on GET, so email scanners cannot opt out a recipient merely by visiting. A
frontend can instead call public `POST /api/unsubscribe` with
`{ "email": "person@example.com" }` (maximum body 4 KiB). Addresses are trimmed,
lowercased, and permanently opted out even before an account exists. All matching
accounts are updated atomically. Repeated requests return the same `{ "ok": true }`
confirmation for registered and unregistered addresses.

Browser origins follow `YAPERN_ORIGINS` and the existing Yapern/local defaults.
The backend-hosted unsubscribe form also permits its own origin.
Run `npm run test:admin` and `npm run test:marketing` for focused checks.

## Discussion API

Collection reads retain `select`, `eq.` filters, `order=field.asc` or
`field.desc`, and `limit`/`offset` pagination. The maximum page size is 100.
Responses retain the frontend's `{ "data": [...] }` shape. Profile updates
require `id=eq.<your-user-id>`; message deletion requires an exact `id` filter
and accepts the frontend's additional board and author filters. Creation returns
201; deletion returns `{ "data": [], "meta": { "changes": 1 } }`.

Messages expose a read-only `reply_count` containing every reply in the thread,
including replies to replies. Migration
`013_reply_counts.sql` backfills existing totals once, then database triggers
adjust the counter atomically on reply insert or delete. Message
reads do not count or join replies. Apply the migration and deploy the API before
deploying the web app that requests `reply_count`.

Nested replies require `014_nested_replies.sql`. Apply it and deploy the API
before deploying the web app that requests `parent_reply_id` and reply-level
`direct_reply_count`. Existing replies retain their IDs, content, votes,
notifications, and timestamps, with `parent_reply_id: null` and zero children.

Send authenticated `POST /tables/replies` with
`{ "message_id": "<root-message-id>", "body": "...", "parent_reply_id": "<reply-id>" }`.
Omit `parent_reply_id` or send null to reply directly to the message. A nested
parent must exist in the same message; missing, deleted, or mismatched targets
return 404. The server derives the author from the session. There is no
application depth limit. Every reply retains the root `message_id`, the nullable
immediate `parent_reply_id`, and a read-only `direct_reply_count` of immediate
children only. Inserts and deletes update one immediate parent atomically in
O(1), independent of depth; message `reply_count` still counts the whole thread.

Use `/messages/<messageId>/replies?limit=20&sort=new` for the first 20 direct
replies to a message. Add `parent_reply_id=<replyId>` for that reply's immediate
children; no descendants load automatically. The response is
`{ "data": [...], "meta": { "next_cursor": "..." } }`, with a null cursor when
the branch is exhausted. Pass `cursor=<next_cursor>` to append the next page,
and keep each branch's cursor independent. The maximum page size is 100.
`sort=new` (default) orders newest first, `sort=old` oldest first, and `sort=top`
by cached vote score descending; IDs break ties consistently. The cursor is
opaque and scoped to the message, parent, and sort. Keyset cursors survive
deletion of the last returned item. Top reflects live vote scores: deduplicate
IDs when appending pages and refresh a branch to reflect rank changes.
Dedicated indexes bound branch reads without aggregating sibling votes or
scanning descendants. Each returned row includes joined `author_name`, avoiding
one profile request per author. The old flat `/tables/replies` API remains
available for compatibility; new thread UI should use branch pages.

For a reply deep link, read
`/messages/<messageId>/replies/<replyId>/context?limit=6`. It returns
`{ "data": [...], "meta": { "has_more": true } }`: only the nearest ancestors,
including the target, ordered oldest first. The default is 6 rows and maximum
100; siblings and descendants are excluded. When ancestry is truncated, the
first returned reply's `parent_reply_id` points to earlier context.

Reply composers should generate one `Idempotency-Key` per submission and reuse
it across retries. The optional header accepts 8–128 characters from letters,
digits, `.`, `_`, `:`, and `-`, starting with a letter or digit; UUIDs work.
Keys are unique per authenticated user. The same key, root, parent, and trimmed
body returns the original reply with 201 and creates no duplicate counters,
votes, or notifications. Reusing a key for another target or body returns 409
`idempotency_conflict`. Calls without a key retain legacy creation behavior.

Thread pointers and IDs are immutable, including direct SQL replacements;
database guards prevent cycles and cross-message parents. Deleting a message
removes its complete reply tree, votes, and notifications. There is no reply
deletion API. Direct SQL cannot delete a reply while leaving its descendants;
an atomic deletion of a complete subtree is permitted and maintains totals.

Voting requires migration `012_votes.sql`, which gives existing messages and
replies their author's initial +1 vote and preserves existing notifications.
New messages and replies receive the same author vote automatically. Apply the
migration before deploying the API, then deploy the web app.

Read `/votes?message_ids=<id>,<id>&reply_ids=<id>` with up to 100 IDs of each
type. Each returned row contains `id`, `type` (`message` or `reply`), `score`,
and `user_vote`. Missing targets are omitted. Public reads return `user_vote: 0`;
include a bearer session to read your contribution.

Send authenticated `PUT /votes` with `{ "message_id": "<id>", "value": 1 }`
or `{ "reply_id": "<id>", "value": 0 }`. Each user has one contribution per
target, limited to -1, 0, or +1. Repeating a value leaves the score unchanged.
Opposite votes pass through zero: downvoting after your upvote removes it first,
changing a score of 2 back to 1. Setting +1 directly to -1, or the reverse,
returns 409. The author already contributes +1 and cannot add another upvote.
An upvote sends the target's author a notification, excluding self-votes.
Each actor creates at most one upvote notification per target; removing and
restoring a vote preserves the existing notification and its read state.

Search uses D1 FTS5 indexes over message titles/bodies and board slugs/names/
descriptions. Apply `011_full_text_search.sql` before deploying the API, then
deploy the web app. The migration indexes existing content and creates triggers
that maintain the indexes in the same transaction as inserts, edits, and deletes.
Public text IDs remain unchanged; the indexes join on SQLite's integer rowid.

Use `/search?q=sqlite+ind&type=messages&sort=relevance&limit=20&offset=0`.
`q` accepts up to 200 characters and 20 words; all words must match, and the last
word matches prefixes. Punctuation separates words and FTS operators are treated
as literal words. Matching ignores case and diacritics; there is no typo or
semantic matching. `type` is `messages` (default) or `boards`, `sort` is
`relevance` (default) or `newest`, and optional `board` filters by an exact slug.
Replies are not searched. Relevance weights message titles and board names/slugs
above body text. Results include plain-text snippets and current author/board
metadata; consumers must render snippets as text. Pagination accepts limits of
1–50 and offsets of 0–1000. `meta.has_more` reports whether another permitted
page exists, without running an unbounded count query. Search follows collection
CORS rules and does not require a session.

FTS indexes consume D1 storage and add work to content writes. Check query plans,
`meta.rows_read`, and latency with realistic content before increasing traffic or
pagination limits. Rebuild with `INSERT INTO messages_fts(messages_fts)
VALUES('rebuild')` (and the equivalent for `boards_fts`) if needed after bulk data
repair. Do not edit FTS shadow tables directly.

Board edits require `id=eq.<board-id>` and the board creator's bearer session.
Send JSON `{ "description": "..." }` to edit the description, adding
`"remove_logo": true` to remove the logo. For an upload or replacement, send
`multipart/form-data` with a `description` field and a `logo` file. PNG, JPEG,
WebP, and GIF files up to 5 MiB are accepted after signature and MIME checks.
The file is stored in the existing `BUCKET` binding under `board-logos/`, and
the nullable `logo_url` board field contains its public API path. Replacement
and removal clean up the previous object after the board update succeeds.
Apply `008_board_logos.sql` before deploying the API, then deploy the web app.

Message creation also accepts `multipart/form-data` with `board_id`, `title`,
an optional `body`, and an `image` file, using the same formats, signature checks,
and 5 MiB limit as logos. Images go into the root `board-messages/` folder in
the existing bucket. The API prepends the public image URL to the message body
and records its path in `image_url` for cleanup when the message is deleted.
The combined body, including the image URL, must fit within 2000 characters.
Failed message creation removes the uploaded object. Apply
`009_message_images.sql` before deploying the API, then deploy the web app.

Reply and upvote notifications use one SQLite-backed `UserNotifications` Durable Object per
recipient, with Cloudflare's [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/).
The `NOTIFICATIONS` binding and `v1-notifications` Durable Object migration are
configured in `wrangler.jsonc`. Apply `010_reply_notifications.sql` before
deploying the API, then deploy the web app. `npm run deploy` applies D1 migrations
and deploys the Worker with its Durable Object migration.

A D1 trigger creates an unread notification in the same transaction as each
reply or first upvote, excluding notifications for your own actions.
Reply notifications go to the immediate parent author: the message author for
a direct reply, or the replied-to reply's author for a nested reply. Snapshot
entries include `kind` (`reply` or `upvote`), the root `message_id`, and a
nullable `reply_id` identifying a reply when applicable. D1 retains unread state while
all tabs are closed; opening a socket sends the current persisted snapshot.
Successful writes push snapshots to all connected recipient tabs. The existing
five-minute cron retries failed deliveries using the durable notification
outbox. Deleting a message cascades its notifications and refreshes every
affected recipient's connected tabs. The inbox keeps read notifications and
returns the latest 50.

`POST /notifications/read` accepts `{ "through_id": <last_id from a snapshot> }`.
It acknowledges only notifications through that ID, preserving later notifications,
and broadcasts the updated count across tabs. Every snapshot carries a monotonic
per-user `version` so clients can discard delayed responses.

HTTP notification routes require the existing bearer session. Browsers exchange
it for an expiring, single-use socket ticket; bearer tokens never go in URLs.
Socket upgrades require an allowed Origin, and ticket consumption rechecks the
session. Each push rechecks attached session hashes and closes revoked or
expired sessions. The runtime answers `ping` with `pong` without waking a
hibernating object; clients reconnect with bounded backoff after disconnection.

`POST /og-image` accepts `{ "url": "https://example.com" }` with a bearer
session. Open Graph and Twitter images return immediately with HTTP 200 and
`{ image, source, status: "ready" }`. When neither image is available, a
Cloudflare Queue job renders a 1200×630 JPEG with Browser Run and stores it in
the existing R2 bucket under `previews/`.

Queued responses use HTTP 202 and include `{ image, source, status: "pending",
previewId, statusUrl }` plus `Retry-After: 3`. The initial image is a validated
favicon, or null. Poll `GET /previews/{id}` with the same bearer session until
HTTP 200: a successful result has `source: "screenshot"`, while rendering
failures retain the favicon/placeholder with `status: "failed"`. The web client
handles this polling and cancellation. Status URLs are private to their owner;
`GET` and `HEAD /preview-images/{id}.jpg` serve the JPEG publicly so it can be
displayed in shared messages.

Fallback responses include `diagnostics.metadata` and/or
`diagnostics.screenshot` when a stage failed. Each diagnostic has a stable
`code` and a curated `message`, with `httpStatus` and `contentType` when
available; browser service failures may also include the numeric `providerCode`.
Terminal screenshot failures also set top-level `error` to the specific
screenshot code, including when the endpoint returns HTTP 200. The API does not
return raw browser provider messages. Worker logs use the `[link-preview]`
prefix and include the preview ID, target host, HTTP status, diagnostic,
elapsed time, and internal error details for investigation.
Cache reads also log the preview ID, state, diagnostics, error code, and expiry
time. Metadata and screenshot requests use the same desktop Chrome user agent.
DNS validation ignores CNAME names and checks every resolved IP address; it
requires at least one IP and rejects private or reserved addresses.

Jobs deduplicate normalized URLs per user. Screenshots expire after 14 days;
failures are cached for six hours. Limits are 100 new screenshots per user per
UTC day and 1,000 cached jobs per user. Queue consumers use expiring leases to
handle duplicate deliveries; polling recovers stalled jobs. A five-minute cron
removes expired jobs and R2 objects, including objects belonging to deleted
accounts. Rendering rejects unsafe destinations, blank/error/challenge pages,
oversized images, and requests exceeding the 25-second browser deadline.

Apply migrations `005_link_previews.sql`, `006_preview_diagnostics.sql`, and
`007_expire_dns_preview_failures.sql` in order before deploying this feature.
Migration 006 adds stored diagnostics to preview jobs. Migration 007 expires
only cached `preview_dns_not_public` failures so those URLs retry DNS validation
after the CNAME handling fix. Failures already cached for six hours before
migration 006 have no recorded details and can only report their legacy error
code. Wrangler
binds the `yapern-previews` queue as `PREVIEW_QUEUE` and configures its consumer
and cleanup cron. If it does not exist yet, create it with
`npx wrangler queues create yapern-previews` before deploying. The browser
binding uses `remote: true` because [Browser Run Quick Actions require a remote
browser during local development](https://developers.cloudflare.com/browser-run/quick-actions/).
D1, R2, and queue development state remain local; screenshot jobs use the live
Cloudflare browser service.

Browser requests are allowed from `https://yapern.com`, `https://www.yapern.com`,
and localhost/127.0.0.1 on Vite ports 5173 and 4173. Set the optional Worker
variable `YAPERN_ORIGINS` to a comma-separated list of exact origins to replace
these defaults. Requests use bearer tokens, without cookies.

Apply migration `004_email_auth.sql` before deploying these routes. Password
credentials are stored separately from public profiles; existing users and
sessions are preserved. Accounts, password hashes, sessions, and content in the
old generic backend are not automatically transferred by switching the API
origin. Existing local users without credentials cannot be claimed through
email sign-up. Passwords require at least eight characters for new accounts.
