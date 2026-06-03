# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

GPNEWS ("ഗൾഫ് പത്രിക") — a Malayalam Gulf news channel website. Capabilities:
- Editorial news (admin-managed articles, breaking ticker, media library) under `/admin`. New articles **default to `featured=true`** (via `prepareCreate()` in `routes/articles.ts`) so any added story auto-surfaces in the home hero/featured feed (newest-first); admins can uncheck Featured. **Bulk add** at `/admin/articles/bulk` (`POST /articles/bulk`, `requireAdmin`, all-or-nothing, max 50 rows) creates many stories across categories at once. Each article supports **multiple images**: a cover (`imageUrl`) plus an unlimited `images` jsonb gallery (string[]) — managed in the article form (upload/library/URL, reorder/remove) and rendered as a gallery on the public article page. The public GP Update page (`/ai-news`) and category chips show **English** category labels (`meta.en`); only news content stays Malayalam.
- **AI Live News** (`/ai-news`): fetches real RSS news per category (sports/international/health/war), filters banned topics (Kuwait ministry/illegal/fake via deterministic blocklist + AI moderation), translates/rewrites to Malayalam via OpenAI (`gpt-4o` — Malayalam quality is the site's core credibility; override with `AI_NEWS_MODEL`), auto-refreshes every 2-3h, archives headings and purges website copy every 24h with backup to Google Drive + DB (+ optional email). Admin controls at `/admin/ai-news` — beyond running the cycle, admins can **edit any live update** (title ml/en, summary, content, category, photo via Media Library/upload) or delete it. A **master News-Engine ON/OFF switch** (admin-only) lives here: stored in `site_settings.header.automation.newsEnabled` (jsonb, default true, no migration); `isNewsAutomationEnabled()` (`lib/automation.ts`, fail-open) gates `runNewsCycle` so when paused it skips purge+generate (and thus AI autopost) unless `force` (manual "Generate now"/"Run full cycle") bypasses it — `job.ts` inherits the gate. This delivers 24/7 control at no extra cost (autoscale + scheduled job kept; no always-on VM). Edit/delete via `PATCH`/`DELETE /api/ai-news/:id` (`requireAdmin`). **AI news is photos-only — no video embeds** (the user removed video from AI news; editorial articles and home blocks still support video). To maximize a *matching* photo per story, generation first uses RSS media (enclosure/`media:content`/thumbnail/inline `<img>`); when the feed has no image it does one bounded fetch of the article page (`fetchOgMedia` in `news-sources.ts`: 7s abort + ~256KB body cap, only for image-less items) to pull `og:image`/`twitter:image`. No image found → the item publishes text-only.
- **GP Live Connect** (`/live`): members-only Jitsi video conference + chat rooms for Kerala-Gulf community. Register/login with token sessions; create/join rooms (embedded `meet.jit.si` iframe). Admin moderation at `/admin/community` (`requireAdmin`): list all rooms (active + closed), force close/reopen/delete a room, bulk-purge old rooms (`POST /community/admin/rooms/purge` `{days,onlyInactive}`), and list/delete members (delete also drops sessions + closes their rooms). The Jitsi `roomKey` is never returned by any admin route — it is needed only for joining, not moderation.
- **AI Help Assistant** (`/admin/assistant`, admin-only): chat helper that answers operational "how do I…" questions about running GPNEWS (managing news, home page, AI news, social posting, customization). `POST /api/admin/assistant` (`requireAdmin`) calls OpenAI via the shared `lib/openai.ts` proxy with a static GPNEWS-grounding system prompt (no DB/tool access); replies in the same language the admin asks (English or Malayalam). Model via `ASSISTANT_MODEL` (default `gpt-4o-mini`). Keep the grounding prompt in sync with this Product section when admin features change.
- **Social auto-posting** (`/admin/social`, admin-only): auto-shares published news to a Facebook Page + Instagram via Meta Graph API. Toggles persist in `site_settings.header.social` (no migration); credentials are env secrets (`FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`, `IG_BUSINESS_ID`). Posting is fire-and-forget on publish; the standalone `job.ts` calls `flushSocialPosts()` before exit so scheduled/AI posts aren't cut off.
- **Site customization** (admin): full no-code site control.
  - Customize Site (`/admin/customize`): theme colors, fonts, base size, corner radius; header (site name, tagline, logo upload, search/top-bar/date toggles); banner (image, link, height, alignment).
  - Advertisements (`/admin/ads`): image ad manager with placements `header` / `in-feed` / `footer`, link, order, show/hide.
  - Homepage Layout (`/admin/layout`): add/remove/reorder/toggle homepage blocks (`hero`, `featured-grid`, `latest-list`, `live-tv`, `ad`, `html`) with column/count controls.
  - Visual Editor (`/admin/visual`): freeform Canva-style canvas for the home page (react-rnd). Drag/resize/style every block on a scaled design canvas (`FREEFORM_DESIGN_WIDTH=1200`), edit position/size + box style (bg, padding, radius, shadow, opacity, z-index) + per-block content in a properties panel. "Save & publish" persists `layout.mode="freeform"` (+ `canvasHeight` + per-block `freeform {x,y,w,h}` and `blockStyle`); "Use grid" flips `mode` back to the responsive 12-col grid without discarding freeform metadata. Both modes share the same `HomeBlockView` renderer (`components/home-blocks.tsx`) — public `home.tsx` renders `FreeformStage` (`components/freeform-stage.tsx`, scale-to-fit) when `mode==="freeform"`, else the grid (backward-compatible). Layout is plain jsonb (no migration); `sanitizeLayout` (`routes/site.ts`) clamps `canvasHeight`/freeform geometry/blockStyle numbers so malformed payloads can't break the public render.
  - Navigation Menu (`/admin/menu`): fully editable top-nav — rename/reorder/show-hide/add/remove every item, set color + pulse dot. Stored in `site_settings.header.navItems` (existing jsonb column, no migration); hrefs sanitized server-side (internal `/path` or `http(s)` only). Menu labels are always English; absolute links render as native `<a target=_blank>`.
  - Categories (`/admin/categories`): CRUD for news categories (English `name`, `nameMl`, slug, color). Public category chips always render the English `name` (only news content stays Malayalam).
  - Custom Pages (`/admin/pages`): CRUD pages rendered at `/p/:slug`, with menu visibility + ordering.
  - Data model in `lib/db/src/schema/site.ts` (`site_settings` single-row, `advertisements`, `custom_pages`). API in `artifacts/api-server/src/routes/site.ts`. Frontend provider `artifacts/gpnews/src/lib/site-settings.tsx` injects theme CSS vars. **Admin-authored HTML (custom pages + html blocks) is sanitized server-side with `sanitize-html` before persistence** to prevent stored XSS.

## Operational notes
- AI news uses the **Replit-managed OpenAI integration** (`AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`, auto-provisioned) — no separate OpenAI billing needed; usage is billed to Replit credits. `lib/openai.ts` falls back to a direct `OPENAI_API_KEY` if the proxy is absent.
- Admin login fails closed: requires `ADMIN_USERNAME` + `ADMIN_PASSWORD` env vars (no insecure defaults).
- OpenAI client is lazy-initialized — a missing key never crashes server boot, only AI-news generation.
- Scheduler uses `node-cron` and runs only while the process is alive. `ai_news.source_url` has a unique index to prevent duplicate inserts across concurrent runs.
- **Guaranteed scheduling (autoscale-safe):** the API deploys as autoscale, which scales to zero when idle — so the in-process cron can stop, leaving scheduled articles unpublished and expired ones lingering. The standalone job entrypoint `pnpm --filter @workspace/api-server run job` (`artifacts/api-server/src/job.ts` → `dist/job.mjs`) runs one pass and exits: it calls `processScheduledArticles()` (publish due scheduled, archive expired) and `runNewsCycle()` (purge >24h news + refresh only when stale), then exits 0 (1 on failure). To guarantee 24/7 scheduling independent of web traffic, create a **Scheduled Deployment** in the Publishing UI with run command `pnpm --filter @workspace/api-server run job` (build `pnpm --filter @workspace/api-server run build`) on a 5-15 min cadence. The job is cheap to run frequently: `processScheduledArticles()` uses idempotent guarded UPDATEs (safe to run concurrently with the in-process cron), and news generation is gated by a freshness check + a Postgres advisory lock so it never over-generates or double-runs.
- Optional email backup needs `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`; degrades gracefully (DB + Drive backup always run). Defaults `MAIL_TO=gpnewslive@gmail.com`.
- **Master automation switch governs social posting too:** `header.automation.newsEnabled` (the admin Channel-automation toggle on `/admin/ai-news`) now gates BOTH `runNewsCycle` AND `postNewsToSocial`. When set to Manual, automatic AI news *and* automatic Facebook/Instagram posts pause together; the public site keeps serving and the date/time clock keeps running (frontend, never gated). Manual *news* actions still work — "Generate now" / "Run full cycle" pass `force:true` to bypass the **news-cycle** gate so admins can refresh content while paused — but those forced runs deliberately do NOT auto-broadcast to social while in Manual mode (avoids surprise posts to the public FB/IG pages). The only forced *social* action is the explicit **Social test post** (`POST /api/social/test`, `force:true`), which always works. Gate is fail-open (a settings-read error never silently stops the channel).
- **Deploy stability — pg Pool error listener (critical):** managed Postgres severs idle pooled connections (code `57P01`, "terminating connection due to administrator command"). `lib/db/src/index.ts` attaches `pool.on("error", …)` (logs to stderr, non-fatal) + `keepAlive:true`. Without this listener, Node treats the async Pool `error` as unhandled and kills the process → autoscale crash-loop → outage. Any committed deploy fix only takes effect after a **republish**.
- **OpenAI 401/403 circuit breaker:** an invalid/expired AI credential used to flood logs with a 401 per item per category every cycle. `reviewAndTranslate` now rethrows a typed `AiAuthError` on 401/403 and `generateAiNews` aborts the cycle after one actionable log line. The 401 itself is an env/secret issue — re-check the Replit OpenAI integration / `OPENAI_API_KEY` **in the deployment environment** if AI news stops producing.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
