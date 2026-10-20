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
| GET | `/tables/boards` | Read boards |
| POST | `/tables/boards` | Create a board |
| PATCH | `/tables/boards` | Update the description and logo of a board you created |
| GET / HEAD | `/board-logos/:filename` | Read a public board logo from R2 |
| GET | `/tables/messages` | Read messages |
| POST | `/tables/messages` | Create a titled message |
| GET / HEAD | `/board-messages/:filename` | Read a public message image from R2 |
| DELETE | `/tables/messages` | Delete your message and its replies |
| GET | `/tables/replies` | Read replies |
| POST | `/tables/replies` | Reply to an original message |
| GET | `/tables/users` | Read public author IDs and display names |
| PATCH | `/tables/users` | Update your display name |
| POST | `/og-image` | Read link metadata or queue a screenshot |
| GET | `/previews/{id}` | Read your screenshot job status |
| GET, HEAD | `/preview-images/{id}.jpg` | Read a public cached screenshot |

Collection reads retain `select`, `eq.` filters, `order=field.asc` or
`field.desc`, and `limit`/`offset` pagination. The maximum page size is 100.
Responses retain the frontend's `{ "data": [...] }` shape. Profile updates
require `id=eq.<your-user-id>`; message deletion requires an exact `id` filter
and accepts the frontend's additional board and author filters. Creation returns
201; deletion returns `{ "data": [], "meta": { "changes": 1 } }`.

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
