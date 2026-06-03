import { Router } from "express";
import { db } from "@workspace/db";
import { articlesTable } from "@workspace/db";
import { eq, desc, and, or, sql, isNull, gt, gte } from "drizzle-orm";
import {
  ListArticlesQueryParams,
  CreateArticleBody,
  GetArticleParams,
  UpdateArticleParams,
  UpdateArticleBody,
  DeleteArticleParams,
  GetRecentArticlesQueryParams,
  GetTrendingArticlesQueryParams,
} from "@workspace/api-zod";
import { requireAdmin, isAdminRequest } from "./admin.js";
import { sanitizeVideoUrl } from "../lib/video-embed.js";
import { postNewsToSocial, articleUrl } from "../lib/social.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Conditions that gate which articles a public (non-admin) visitor may see:
// only published stories that have not passed their expiry time. Scheduled
// stories carry status "scheduled" until the scheduler promotes them, so they
// are naturally excluded here; the expiry check hides articles the instant they
// lapse, even before the archive cron next runs.
function publicConditions() {
  return [
    eq(articlesTable.status, "published"),
    or(isNull(articlesTable.expireAt), gt(articlesTable.expireAt, new Date())),
  ];
}

// Normalize fields coming from the admin form before they hit the DB. This is
// the single write choke point for both create (prepareCreate) and patch, so it
// also performs security normalization that must run on every write:
//   - convert ISO date strings (or empty values) to Date | null, and demote a
//     "published" article with a future publish time to "scheduled" so the cron
//     publishes it on time instead of it appearing immediately;
//   - run admin-supplied videoUrl through sanitizeVideoUrl() so a malicious
//     value (e.g. javascript:...) can never be stored and later rendered into
//     the public article-page <iframe src> — that would be stored XSS able to
//     steal the bearer tokens kept in browser storage.
function normalizePlacement<T extends Record<string, any>>(data: T): T {
  const out: Record<string, any> = { ...data };
  const toDate = (v: any) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };
  if ("publishAt" in out) out.publishAt = toDate(out.publishAt);
  if ("expireAt" in out) out.expireAt = toDate(out.expireAt);
  if (out.status === "published" && out.publishAt && out.publishAt > new Date()) {
    out.status = "scheduled";
  }
  if ("videoUrl" in out) out.videoUrl = sanitizeVideoUrl(out.videoUrl);
  return out as T;
}

router.get("/articles", async (req, res) => {
  const parsed = ListArticlesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query params" });
  }
  const { category, language, offset = 0, featured } = parsed.data;
  const limit = Math.min(parsed.data.limit ?? 20, 100);

  const conditions = [...publicConditions()];
  // A story belongs to a category if it is its primary category OR it lists the
  // category among its additional (cross-posted) categories.
  if (category)
    conditions.push(
      or(
        eq(articlesTable.category, category),
        sql`${articlesTable.extraCategories} @> ${JSON.stringify([category])}::jsonb`,
      ),
    );
  if (language) conditions.push(eq(articlesTable.language, language as "ml" | "en" | "ta" | "te"));
  if (featured !== undefined) conditions.push(eq(articlesTable.featured, featured));

  const articles = await db
    .select()
    .from(articlesTable)
    .where(and(...conditions))
    .orderBy(desc(articlesTable.priority), desc(articlesTable.createdAt))
    .limit(limit)
    .offset(offset);

  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(articlesTable)
    .where(and(...conditions));

  return res.json({ articles, total: Number(totalResult[0]?.count ?? 0) });
});

router.get("/articles/featured", async (_req, res) => {
  const articles = await db
    .select()
    .from(articlesTable)
    .where(and(...publicConditions(), eq(articlesTable.featured, true)))
    .orderBy(desc(articlesTable.priority), desc(articlesTable.createdAt))
    .limit(6);
  return res.json(articles);
});

router.get("/articles/recent", async (req, res) => {
  const parsed = GetRecentArticlesQueryParams.safeParse(req.query);
  const limit = Math.min(parsed.success && parsed.data.limit ? parsed.data.limit : 10, 50);

  const articles = await db
    .select()
    .from(articlesTable)
    .where(and(...publicConditions()))
    .orderBy(desc(articlesTable.createdAt))
    .limit(limit);

  return res.json(articles);
});

router.get("/articles/trending", async (req, res) => {
  const parsed = GetTrendingArticlesQueryParams.safeParse(req.query);
  const limit = Math.min(parsed.success && parsed.data.limit ? parsed.data.limit : 8, 50);
  // Trending = most-viewed among recent (last 14 days) published stories, so a
  // single old viral piece does not permanently dominate the slot.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const articles = await db
    .select()
    .from(articlesTable)
    .where(and(...publicConditions(), gte(articlesTable.createdAt, since)))
    .orderBy(desc(articlesTable.viewCount), desc(articlesTable.createdAt))
    .limit(limit);

  return res.json(articles);
});

router.get("/articles/:id", async (req, res) => {
  const parsed = GetArticleParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

  const article = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.id, parsed.data.id))
    .limit(1);

  if (!article[0]) return res.status(404).json({ error: "Not found" });

  // Drafts, scheduled, archived, and expired articles are editorial material
  // that must stay inside the admin panel. Only return them to a valid admin; to
  // anonymous callers such an article is indistinguishable from a missing one.
  const a = article[0];
  const isExpired = a.expireAt != null && new Date(a.expireAt) <= new Date();
  if ((a.status !== "published" || isExpired) && !(await isAdminRequest(req))) {
    return res.status(404).json({ error: "Not found" });
  }

  await db
    .update(articlesTable)
    .set({ viewCount: (a.viewCount ?? 0) + 1 })
    .where(eq(articlesTable.id, parsed.data.id));

  return res.json(a);
});

// New stories default to featured=true so that any article an admin adds — from
// any page or category — automatically surfaces on the home page (the hero/
// featured blocks read featured=true, newest-first). Admins can still uncheck
// "Featured" to keep a story out of the home headline rotation.
function prepareCreate<T extends Record<string, any>>(data: T): T {
  const out = normalizePlacement(data) as Record<string, any>;
  if (out.featured === undefined) out.featured = true;
  return out as T;
}

router.post("/articles", requireAdmin, async (req, res) => {
  const parsed = CreateArticleBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const created = await db
    .insert(articlesTable)
    .values(prepareCreate(parsed.data) as any)
    .returning();

  // Auto-post to social media when the story is published immediately (skip
  // drafts/scheduled — those post when the scheduler promotes them). Fire and
  // forget: posting must never block or fail the create response.
  const article = created[0];
  if (article && article.status === "published") {
    postNewsToSocial({
      title: article.title,
      summary: article.summary,
      link: articleUrl(article.id),
      imageUrl: article.imageUrl,
    }).catch((err) => logger.error({ err }, "Social auto-post (create) failed"));
  }

  return res.status(201).json(article);
});

// Bulk create: lets an admin add many stories at once across pages/categories
// (e.g. Main News 1-3, Kuwait News 1-2, AI News 1-2 ...) in a single request.
// Each row is validated independently; the whole batch is rejected if any row is
// invalid so the admin gets a clear all-or-nothing result.
router.post("/articles/bulk", requireAdmin, async (req, res) => {
  const rows = (req.body as { articles?: unknown })?.articles;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty 'articles' array" });
  }
  if (rows.length > 50) {
    return res.status(400).json({ error: "At most 50 articles per batch" });
  }

  const values: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const parsed = CreateArticleBody.safeParse(rows[i]);
    if (!parsed.success) {
      return res.status(400).json({ error: `Invalid article at row ${i + 1}`, row: i });
    }
    values.push(prepareCreate(parsed.data));
  }

  const created = await db.insert(articlesTable).values(values).returning();
  return res.status(201).json({ created, count: created.length });
});

router.patch("/articles/:id", requireAdmin, async (req, res) => {
  const paramsParsed = UpdateArticleParams.safeParse({ id: Number(req.params.id) });
  if (!paramsParsed.success) return res.status(400).json({ error: "Invalid id" });

  const bodyParsed = UpdateArticleBody.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

  const updated = await db
    .update(articlesTable)
    .set({ ...(normalizePlacement(bodyParsed.data) as any), updatedAt: new Date() })
    .where(eq(articlesTable.id, paramsParsed.data.id))
    .returning();

  if (!updated[0]) return res.status(404).json({ error: "Not found" });
  return res.json(updated[0]);
});

router.delete("/articles/:id", requireAdmin, async (req, res) => {
  const parsed = DeleteArticleParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

  await db.delete(articlesTable).where(eq(articlesTable.id, parsed.data.id));
  return res.status(204).send();
});

export default router;
