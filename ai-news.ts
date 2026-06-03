import { Router } from "express";
import { db, aiNewsTable, aiNewsArchiveTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireAdmin } from "./admin.js";
import { runNewsCycle } from "../lib/scheduler.js";
import { generateAiNews, purgeOldAiNews } from "../lib/ai-news-service.js";
import { CATEGORY_LABELS } from "../lib/news-sources.js";

const router = Router();

// Public: list live AI news (optionally by category)
router.get("/ai-news", async (req: any, res: any) => {
  try {
    const category = req.query.category as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 60), 100);
    const base = db.select().from(aiNewsTable).orderBy(desc(aiNewsTable.createdAt)).limit(limit);
    const rows = category
      ? await db.select().from(aiNewsTable).where(eq(aiNewsTable.category, category)).orderBy(desc(aiNewsTable.createdAt)).limit(limit)
      : await base;
    return res.json({ items: rows, categories: CATEGORY_LABELS });
  } catch (err: any) {
    req.log?.error(err, "List AI news failed");
    return res.status(500).json({ error: "Failed to load AI news" });
  }
});

// Public: single AI news item
router.get("/ai-news/item/:id", async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    const rows = await db.select().from(aiNewsTable).where(eq(aiNewsTable.id, id)).limit(1);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json(rows[0]);
  } catch (err: any) {
    req.log?.error(err, "Get AI news failed");
    return res.status(500).json({ error: "Failed" });
  }
});

// Public: archived headings (kept after 24h purge)
router.get("/ai-news/archive", async (req: any, res: any) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 200);
    const rows = await db
      .select()
      .from(aiNewsArchiveTable)
      .orderBy(desc(aiNewsArchiveTable.archivedAt))
      .limit(limit);
    return res.json({ items: rows });
  } catch (err: any) {
    req.log?.error(err, "List archive failed");
    return res.status(500).json({ error: "Failed to load archive" });
  }
});

// Accepts only http(s) URLs; returns null for anything else (e.g. javascript:)
function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : null;
}

const EDITABLE_CATEGORIES = ["kuwait", "gulf", "kerala", "international", "sports", "health", "war"];

// Admin: edit a live AI news item (title, summary, content, category, photo)
router.patch("/ai-news/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};

    if (typeof b.titleMl === "string") {
      const t = b.titleMl.trim();
      if (!t) return res.status(400).json({ error: "Title cannot be empty" });
      updates.titleMl = t;
    }
    if (typeof b.titleEn === "string") updates.titleEn = b.titleEn.trim() || null;
    if (typeof b.summaryMl === "string") updates.summaryMl = b.summaryMl.trim() || null;
    if (typeof b.contentMl === "string") {
      const c = b.contentMl.trim();
      if (!c) return res.status(400).json({ error: "Content cannot be empty" });
      updates.contentMl = c;
    }
    if (typeof b.category === "string") {
      const cat = b.category.trim().toLowerCase();
      if (!EDITABLE_CATEGORIES.includes(cat)) return res.status(400).json({ error: "Invalid category" });
      updates.category = cat;
    }
    if ("imageUrl" in b) updates.imageUrl = cleanUrl(b.imageUrl);

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });

    const rows = await db.update(aiNewsTable).set(updates).where(eq(aiNewsTable.id, id)).returning();
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json(rows[0]);
  } catch (err: any) {
    req.log?.error(err, "Edit AI news failed");
    return res.status(500).json({ error: "Update failed" });
  }
});

// Admin: delete a live AI news item
router.delete("/ai-news/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const rows = await db.delete(aiNewsTable).where(eq(aiNewsTable.id, id)).returning();
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error(err, "Delete AI news failed");
    return res.status(500).json({ error: "Delete failed" });
  }
});

// Admin: trigger a generation now
router.post("/ai-news/generate", requireAdmin, async (req: any, res: any) => {
  try {
    const count = await generateAiNews(5);
    return res.json({ success: true, inserted: count });
  } catch (err: any) {
    req.log?.error(err, "Manual generate failed");
    return res.status(500).json({ error: "Generation failed" });
  }
});

// Admin: trigger purge/backup now
router.post("/ai-news/purge", requireAdmin, async (req: any, res: any) => {
  try {
    const purged = await purgeOldAiNews();
    return res.json({ success: true, purged });
  } catch (err: any) {
    req.log?.error(err, "Manual purge failed");
    return res.status(500).json({ error: "Purge failed" });
  }
});

// Admin: run a full cycle (purge + refresh)
router.post("/ai-news/cycle", requireAdmin, async (req: any, res: any) => {
  runNewsCycle({ force: true }).catch(() => {});
  return res.json({ success: true, message: "News cycle started" });
});

export default router;
