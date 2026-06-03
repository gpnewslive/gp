import { Router } from "express";
import { db } from "@workspace/db";
import { breakingNewsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { CreateBreakingNewsBody, DeleteBreakingNewsParams } from "@workspace/api-zod";
import { requireAdmin } from "./admin.js";

const router = Router();

router.get("/breaking-news", async (_req, res) => {
  const items = await db
    .select()
    .from(breakingNewsTable)
    .where(eq(breakingNewsTable.active, true))
    .orderBy(desc(breakingNewsTable.createdAt))
    .limit(10);
  return res.json(items);
});

router.post("/breaking-news", requireAdmin, async (req, res) => {
  const parsed = CreateBreakingNewsBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const created = await db.insert(breakingNewsTable).values(parsed.data).returning();
  return res.status(201).json(created[0]);
});

router.delete("/breaking-news/:id", requireAdmin, async (req, res) => {
  const parsed = DeleteBreakingNewsParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

  await db.delete(breakingNewsTable).where(eq(breakingNewsTable.id, parsed.data.id));
  return res.status(204).send();
});

export default router;
