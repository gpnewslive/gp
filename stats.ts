import { Router } from "express";
import { db } from "@workspace/db";
import { articlesTable, breakingNewsTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { requireAdmin } from "./admin.js";

const router = Router();

// Admin-only: exposes draft counts and recent rows (including unpublished
// drafts), which are internal newsroom state that must not be public.
router.get("/stats/dashboard", requireAdmin, async (_req, res) => {
  const [totalResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(articlesTable);

  const [publishedResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(articlesTable)
    .where(eq(articlesTable.status, "published"));

  const [draftResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(articlesTable)
    .where(eq(articlesTable.status, "draft"));

  const [viewsResult] = await db
    .select({ total: sql<number>`coalesce(sum(view_count), 0)` })
    .from(articlesTable);

  const [breakingResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(breakingNewsTable)
    .where(eq(breakingNewsTable.active, true));

  const recentArticles = await db
    .select()
    .from(articlesTable)
    .orderBy(desc(articlesTable.createdAt))
    .limit(5);

  return res.json({
    totalArticles: Number(totalResult?.count ?? 0),
    publishedArticles: Number(publishedResult?.count ?? 0),
    draftArticles: Number(draftResult?.count ?? 0),
    totalViews: Number(viewsResult?.total ?? 0),
    breakingNewsCount: Number(breakingResult?.count ?? 0),
    recentArticles,
  });
});

router.get("/stats/category-counts", async (_req, res) => {
  const counts = await db
    .select({
      category: articlesTable.category,
      count: sql<number>`count(*)`,
    })
    .from(articlesTable)
    .where(eq(articlesTable.status, "published"))
    .groupBy(articlesTable.category)
    .orderBy(sql`count(*) desc`);

  return res.json(counts.map((r) => ({ category: r.category, count: Number(r.count) })));
});

export default router;
