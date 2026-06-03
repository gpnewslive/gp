import { Router } from "express";
import { db } from "@workspace/db";
import { categoriesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin } from "./admin.js";

const router = Router();

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || `category-${Date.now()}`
  );
}

router.get("/categories", async (_req, res) => {
  const categories = await db.select().from(categoriesTable).orderBy(asc(categoriesTable.name));
  return res.json(categories);
});

router.post("/categories", requireAdmin, async (req: any, res: any) => {
  try {
    const { name, nameMl, slug, color } = req.body ?? {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name (English) required" });
    const finalSlug = slugify(slug && typeof slug === "string" ? slug : name);
    const created = await db
      .insert(categoriesTable)
      .values({
        name: name.trim(),
        nameMl: typeof nameMl === "string" && nameMl.trim() ? nameMl.trim() : name.trim(),
        slug: finalSlug,
        color: typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color.trim()) ? color.trim() : "#DC2626",
      })
      .returning();
    return res.status(201).json(created[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "A category with this slug already exists" });
    req.log?.error(err, "Failed to create category");
    return res.status(500).json({ error: "Failed to create category" });
  }
});

router.put("/categories/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const { name, nameMl, slug, color } = req.body ?? {};
    const updated = await db
      .update(categoriesTable)
      .set({
        ...(typeof name === "string" ? { name: name.trim() } : {}),
        ...(typeof nameMl === "string" ? { nameMl: nameMl.trim() } : {}),
        ...(typeof slug === "string" ? { slug: slugify(slug) } : {}),
        ...(typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color.trim()) ? { color: color.trim() } : {}),
      })
      .where(eq(categoriesTable.id, id))
      .returning();
    if (updated.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json(updated[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "A category with this slug already exists" });
    req.log?.error(err, "Failed to update category");
    return res.status(500).json({ error: "Failed to update category" });
  }
});

router.delete("/categories/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    req.log?.error(err, "Failed to delete category");
    return res.status(500).json({ error: "Failed to delete category" });
  }
});

export default router;
