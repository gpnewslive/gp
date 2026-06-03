# Threat Model

## Project Overview

GPNEWS is a publicly deployed Malayalam news site with a React frontend (`artifacts/gpnews`) and an Express API (`artifacts/api-server`) backed by PostgreSQL via Drizzle. It serves public news content, admin-managed editorial workflows, AI-generated news ingestion, media management, and a members-only GP Live Connect community feature built around Jitsi rooms.

Production assumptions for this repository: the public deployment is internet-reachable, TLS is provided by the platform, `NODE_ENV` is `production`, and `artifacts/mockup-sandbox` is dev-only unless production reachability is demonstrated.

## Assets

- **Admin credentials and admin sessions** — the admin panel controls editorial content, ads, pages, site settings, AI-news jobs, media management, and Google Drive imports. Compromise lets an attacker deface the site or access operational data.
- **Member accounts and member sessions** — GP Live Connect accounts store identity and contact details and gate access to private rooms. Compromise enables impersonation and access to member-only conversations.
- **Unpublished editorial content** — draft articles, unpublished pages, breaking items, and internal dashboard data have business value before publication and must not leak to the public.
- **Community room access secrets** — Jitsi room keys act as bearer-style join secrets for member-only rooms. Disclosure breaks the privacy model of GP Live Connect.
- **Third-party integration credentials and data** — Cloudinary, Google Drive, SMTP, and OpenAI credentials are server-side secrets. Misuse could leak backups, media, or incur cost.
- **Public site integrity** — homepage layout, custom HTML blocks, custom pages, articles, breaking news, and AI-generated stories directly affect what every visitor sees.
- **Browser-stored bearer tokens** — admin and member tokens are stored in browser storage, so any same-origin script execution bug becomes account compromise.

## Trust Boundaries

- **Browser to API** — every request from public users, members, and admins crosses into the Express API. The browser is untrusted; authentication and authorization must be enforced server-side.
- **Public to member boundary** — `/live` exposes public browsing and registration flows, but room join details and room control actions must stay limited to authenticated members.
- **Public/member to admin boundary** — `/admin` functionality is protected by an admin bearer token backed by the `admin_sessions` table. Any missing middleware on admin-capable routes is a direct privilege escalation.
- **API to PostgreSQL** — the API has broad access to content, sessions, and room data. Query scoping mistakes can expose drafts, sessions, or private room metadata.
- **API to external services** — the server talks to Cloudinary, Google Drive, OpenAI, email, RSS feeds, and Jitsi. User-controlled or third-party-controlled data must not be able to redirect those integrations or silently publish untrusted output.
- **Admin-authored settings to public rendering** — custom pages, HTML blocks, and video/embed settings cross from privileged content authoring into public rendering. Sanitization and strict allowlisting are the critical controls here.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/*.ts`, `artifacts/gpnews/src/App.tsx`
- **Highest-risk server areas:** `routes/admin.ts`, `routes/articles.ts`, `routes/breaking.ts`, `routes/stats.ts`, `routes/community.ts`, `routes/site.ts`, `routes/media.ts`, `routes/drive.ts`, `routes/system.ts`, `lib/ai-news-service.ts`
- **Highest-risk client sinks:** `pages/article.tsx`, `pages/custom-page.tsx`, `pages/home.tsx`, `components/news-card.tsx`
- **Public surfaces:** article/news listing routes, AI news routes, site settings read routes, custom page reads, stats routes, community registration/login and room listing
- **Authenticated/member surfaces:** `/community/me`, room create/join/close
- **Admin surfaces:** media, drive, site mutation routes, AI-news mutation routes, system health, article and breaking-news management
- **Dismissed-by-user scan note:** treat the current admin login per-process/per-IP throttling behavior as an intentional best-effort device/proxy check; do not re-propose it unless deployment/auth semantics change or it leads to a stronger exploit than rate-limit bypass/lockout.
- **Usually dev-only / ignore unless proven reachable:** `artifacts/mockup-sandbox/**`, build output under `dist/**`

## Threat Categories

### Spoofing

The application uses bearer-style session tokens for both admins and members. The API must require a valid session token for every protected endpoint, must not expose bearer-equivalent secrets in public responses, and must make login endpoints resistant to credential guessing at internet scale.

### Tampering

Public visitors must not be able to create, edit, delete, or reorder editorial content, site settings, ads, pages, media, AI-generated stories, or community resources they do not own. Server-side authorization is the primary guarantee because frontend route guards and hidden buttons are not security controls.

### Information Disclosure

Only published public content should be visible to unauthenticated users. Draft articles, admin dashboard data, room join keys, internal health details, backups, secrets, and member data must not be returned from public endpoints or leaked through overly broad queries.

### Denial of Service

Public endpoints such as login, registration, content fetches, and externally backed refresh operations must be bounded so attackers cannot cheaply exhaust compute, third-party quotas, or database resources. File upload size and external call timeouts are particularly relevant here.

### Elevation of Privilege

Any public or member-accessible route that performs admin-only actions, or any public route that returns member-only join secrets, is a direct privilege escalation. Any stored-content rendering path that can execute same-origin script can also escalate by stealing browser-held bearer tokens from more privileged users.
