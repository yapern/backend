# Yapern API

Run `npm install`, `npm run db:migrate:local`, and `npm run dev` to start the
Worker with a local D1 database. Run `npm test` and `npm run type-check` to verify
changes. Tests use isolated in-memory SQLite databases and require Node 22.13+.

Interactive API documentation is at `/docs`; the OpenAPI document is at
`/openapi.json`.

The existing frontend can use this backend by changing `apiOrigin` in
`src/config.js` to `https://api.yapern.com` (or the local Worker URL).
Its project ID remains `90da3093-84b6-4cd7-a39a-a8afc39403b8`. The legacy
`apikey` header is accepted for compatibility; bearer sessions authorize writes.
This backend serves this one Yapern project.

Routes under `/bff/data/{projectId}`:

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/auth/email` | Sign in, or create a new email account |
| GET | `/auth/session` | Read the signed-in session |
| DELETE | `/auth/session` | Revoke this session |
| GET | `/tables/boards` | Read boards |
| POST | `/tables/boards` | Create a board |
| GET | `/tables/messages` | Read messages |
| POST | `/tables/messages` | Create a titled message |
| DELETE | `/tables/messages` | Delete your message and its replies |
| GET | `/tables/replies` | Read replies |
| POST | `/tables/replies` | Reply to an original message |
| GET | `/tables/users` | Read public author IDs and display names |
| PATCH | `/tables/users` | Update your display name |

Collection reads retain `select`, `eq.` filters, `order=field.asc` or
`field.desc`, and `limit`/`offset` pagination. The maximum page size is 100.
Responses retain the frontend's `{ "data": [...] }` shape. Profile updates
require `id=eq.<your-user-id>`; message deletion requires an exact `id` filter
and accepts the frontend's additional board and author filters. Creation returns
201; deletion returns `{ "data": [], "meta": { "changes": 1 } }`.

`POST /bff/og-image` accepts `{ "url": "https://example.com", "projectId": "…" }`
with a bearer session. It returns a terminal metadata preview using Open Graph,
Twitter, or a favicon fallback. It does not schedule screenshots or return
pending jobs, so the frontend does not need to poll for preview status.

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
