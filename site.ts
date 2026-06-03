import { Router } from "express";
import {
  db,
  siteSettingsTable,
  advertisementsTable,
  customPagesTable,
  type ThemeConfig,
  type HeaderConfig,
  type LayoutConfig,
  type NavItem,
} from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import sanitizeHtml from "sanitize-html";
import { requireAdmin } from "./admin.js";
import { sanitizeVideoUrl } from "../lib/video-embed.js";

const router = Router();

function cleanHtml(input: unknown): string {
  if (typeof input !== "string") return "";
  return sanitizeHtml(input, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "ul", "ol", "li",
      "a", "b", "strong", "i", "em", "u", "s", "br", "hr", "span", "div",
      "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td",
      "iframe", "pre", "code",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      iframe: ["src", "width", "height", "allow", "allowfullscreen", "frameborder", "title"],
      "*": ["style", "class"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedIframeHostnames: ["www.youtube.com", "youtube.com", "player.vimeo.com", "meet.jit.si"],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: "noopener noreferrer", ...(attribs.target ? {} : {}) },
      }),
    },
  });
}

/** Coerce to a finite number within [min,max]; fall back to `fallback`. */
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeLayout(layout: LayoutConfig): LayoutConfig {
  const out: LayoutConfig = {
    ...layout,
    blocks: (layout.blocks ?? []).map((b) => {
      let nb = b;
      if (nb.type === "html" && typeof nb.html === "string") {
        nb = { ...nb, html: cleanHtml(nb.html) };
      }
      if (typeof nb.videoUrl === "string") {
        nb = { ...nb, videoUrl: sanitizeVideoUrl(nb.videoUrl) };
      }
      // Clamp freeform geometry so a malformed admin payload can never produce
      // NaN/negative/absurd boxes that would break the public freeform render.
      if (nb.freeform) {
        nb = {
          ...nb,
          freeform: {
            x: clampNum(nb.freeform.x, -5000, 10000, 0),
            y: clampNum(nb.freeform.y, -5000, 50000, 0),
            w: clampNum(nb.freeform.w, 20, 5000, 300),
            h: clampNum(nb.freeform.h, 20, 10000, 200),
          },
        };
      }
      if (nb.blockStyle) {
        nb = {
          ...nb,
          blockStyle: {
            ...nb.blockStyle,
            opacity: nb.blockStyle.opacity === undefined ? undefined : clampNum(nb.blockStyle.opacity, 0, 1, 1),
            padding: nb.blockStyle.padding === undefined ? undefined : clampNum(nb.blockStyle.padding, 0, 400, 0),
            radius: nb.blockStyle.radius === undefined ? undefined : clampNum(nb.blockStyle.radius, 0, 400, 0),
            zIndex: nb.blockStyle.zIndex === undefined ? undefined : clampNum(nb.blockStyle.zIndex, -9999, 9999, 0),
          },
        };
      }
      return nb;
    }),
  };
  if (layout.canvasHeight !== undefined) {
    out.canvasHeight = clampNum(layout.canvasHeight, 200, 50000, 1800);
  }
  if (layout.canvasWidth !== undefined) {
    out.canvasWidth = clampNum(layout.canvasWidth, 320, 4000, 1200);
  }
  return out;
}

export const DEFAULT_THEME: ThemeConfig = {
  primaryColor: "#c81e1e",
  secondaryColor: "#e0a800",
  backgroundColor: "#fafafa",
  textColor: "#1f2329",
  navColor: "#c81e1e",
  navTextColor: "#ffffff",
  fontFamily: "'Noto Sans Malayalam', 'Inter', sans-serif",
  baseFontSize: 16,
  headingScale: 1,
  radius: 6,
  tableHeaderBg: "#f3f4f6",
  tableBorderColor: "#d4d4d4",
  tableBorderWidth: 1,
  dividerColor: "#e5e7eb",
  dividerWidth: 1,
};

export const DEFAULT_HEADER: HeaderConfig = {
  siteName: "GPNEWS",
  tagline: "ഗൾഫ് പത്രിക",
  logoUrl: "",
  showSearch: true,
  bannerUrl: "",
  bannerLink: "",
  showBanner: false,
  bannerHeight: 120,
  bannerAlign: "center",
  showTopBar: true,
  showDateTime: true,
  dateTimeAlign: "left",
  pageBanners: {},
  dateTimeCorner: "top-right",
  currencyTopPct: 6,
  breakingPosition: "bottom",
  navItems: [
    { id: "home", label: "HOME", href: "/", visible: true },
    { id: "latest", label: "LATEST NEWS", href: "/news", visible: true },
    { id: "gulf", label: "GULF NEWS", href: "/gulf-news", visible: true },
    { id: "kerala", label: "KERALA NEWS", href: "/kerala-news", visible: true },
    { id: "special", label: "GP SPECIAL", href: "/gp-special", visible: true, color: "#fcd34d" },
    { id: "update", label: "GPNEWS UPDATE", href: "/ai-news", visible: true, dot: true },
    { id: "live", label: "LIVE CONNECT", href: "/live", visible: true, color: "#6ee7b7" },
  ],
  social: { autoFacebook: true, autoInstagram: true, autoPostAiNews: false },
  automation: { newsEnabled: true },
};

/**
 * Sanitize admin-supplied nav menu items. Labels are plain text. Hrefs are
 * restricted to internal paths ("/...") or http(s) URLs so a malicious value
 * (e.g. javascript:) can never become a link target. Invalid items are dropped.
 */
function sanitizeNavItems(input: unknown): NavItem[] {
  if (!Array.isArray(input)) return [];
  const out: NavItem[] = [];
  for (const raw of input.slice(0, 30)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim().slice(0, 60) : "";
    const href = typeof r.href === "string" ? r.href.trim().slice(0, 300) : "";
    if (!label || !href) continue;
    const isInternal = href.startsWith("/");
    let isHttp = false;
    if (!isInternal) {
      try {
        const u = new URL(href);
        isHttp = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        isHttp = false;
      }
    }
    if (!isInternal && !isHttp) continue;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 40) : `nav-${out.length}-${Date.now()}`;
    const item: NavItem = {
      id,
      label,
      href,
      visible: r.visible !== false,
    };
    if (typeof r.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(r.color.trim())) item.color = r.color.trim();
    if (r.dot === true) item.dot = true;
    out.push(item);
  }
  return out;
}

// Auto-filling AI news columns. These bind to the live AI feed (source "ai")
// and self-populate on the home page, so the site is never blank even with no
// manually-published articles (e.g. a fresh production database).
const AI_NEWS_BLOCKS: LayoutConfig["blocks"] = [
  { id: "ai-main", type: "news-card", visible: true, source: "ai", aiCategory: "", title: "Main News", colSpan: 12, count: 5, mediaSize: "large", headingBg: "#c81e1e", headingText: "#ffffff", bgColor: "#ffffff", textColor: "#1f2329", showBorder: true, borderColor: "#e5e7eb", fontScale: 1 },
  { id: "ai-international", type: "news-card", visible: true, source: "ai", aiCategory: "international", title: "International", colSpan: 6, count: 4, mediaSize: "large", headingBg: "#1d4ed8", headingText: "#ffffff", bgColor: "#ffffff", textColor: "#1f2329", showBorder: true, borderColor: "#e5e7eb", fontScale: 1 },
  { id: "ai-kerala", type: "news-card", visible: true, source: "ai", aiCategory: "kerala", title: "Kerala News", colSpan: 6, count: 4, mediaSize: "large", headingBg: "#15803d", headingText: "#ffffff", bgColor: "#ffffff", textColor: "#1f2329", showBorder: true, borderColor: "#e5e7eb", fontScale: 1 },
  { id: "ai-sports", type: "news-card", visible: true, source: "ai", aiCategory: "sports", title: "Sports", colSpan: 6, count: 3, mediaSize: "medium", headingBg: "#047857", headingText: "#ffffff", bgColor: "#ffffff", textColor: "#1f2329", showBorder: true, borderColor: "#e5e7eb", fontScale: 1 },
  { id: "ai-health", type: "news-card", visible: true, source: "ai", aiCategory: "health", title: "Health", colSpan: 6, count: 3, mediaSize: "medium", headingBg: "#0f766e", headingText: "#ffffff", bgColor: "#ffffff", textColor: "#1f2329", showBorder: true, borderColor: "#e5e7eb", fontScale: 1 },
];

export const DEFAULT_LAYOUT: LayoutConfig = {
  blocks: [
    { id: "hero", type: "hero", visible: true, title: "Top Stories" },
    { id: "featured-grid", type: "featured-grid", visible: true, columns: 2, count: 2 },
    ...AI_NEWS_BLOCKS,
    { id: "live-tv", type: "live-tv", visible: true },
    { id: "latest-list", type: "latest-list", visible: true, title: "Latest News", count: 6 },
  ],
};

function mergeSettings(row: typeof siteSettingsTable.$inferSelect | undefined) {
  return {
    theme: { ...DEFAULT_THEME, ...(row?.theme ?? {}) },
    header: { ...DEFAULT_HEADER, ...(row?.header ?? {}) },
    layout: row?.layout && Array.isArray(row.layout.blocks) && row.layout.blocks.length > 0
      ? row.layout
      : DEFAULT_LAYOUT,
    updatedAt: row?.updatedAt ?? null,
  };
}

async function getSettingsRow() {
  const rows = await db.select().from(siteSettingsTable).orderBy(asc(siteSettingsTable.id)).limit(1);
  return rows[0];
}

// ---- Site settings (theme / header / layout) ----

router.get("/site-settings", async (_req, res) => {
  try {
    const row = await getSettingsRow();
    return res.json(mergeSettings(row));
  } catch (err) {
    (res.req as any).log?.error(err, "Failed to load site settings");
    return res.json(mergeSettings(undefined));
  }
});

router.put("/site-settings", requireAdmin, async (req: any, res: any) => {
  try {
    const body = req.body ?? {};
    const existing = await getSettingsRow();
    const merged = mergeSettings(existing);

    const nextHeader = body.header ? { ...merged.header, ...body.header } : merged.header;
    if (body.header && "navItems" in body.header) {
      nextHeader.navItems = sanitizeNavItems(body.header.navItems);
    }

    const next = {
      theme: body.theme ? { ...merged.theme, ...body.theme } : merged.theme,
      header: nextHeader,
      layout: body.layout && Array.isArray(body.layout.blocks) ? sanitizeLayout(body.layout) : merged.layout,
      updatedAt: new Date(),
    };

    if (existing) {
      await db.update(siteSettingsTable).set(next).where(eq(siteSettingsTable.id, existing.id));
    } else {
      await db.insert(siteSettingsTable).values(next);
    }
    return res.json(next);
  } catch (err) {
    req.log?.error(err, "Failed to save site settings");
    return res.status(500).json({ error: "Failed to save settings" });
  }
});

// ---- Advertisements ----

router.get("/ads", async (req, res) => {
  try {
    const placement = req.query.placement as string | undefined;
    const where = placement
      ? and(eq(advertisementsTable.active, true), eq(advertisementsTable.placement, placement))
      : eq(advertisementsTable.active, true);
    const rows = await db
      .select()
      .from(advertisementsTable)
      .where(where)
      .orderBy(asc(advertisementsTable.sortOrder), asc(advertisementsTable.id));
    return res.json(rows);
  } catch (err) {
    (res.req as any).log?.error(err, "Failed to load ads");
    return res.json([]);
  }
});

router.get("/ads/all", requireAdmin, async (_req: any, res: any) => {
  const rows = await db
    .select()
    .from(advertisementsTable)
    .orderBy(asc(advertisementsTable.sortOrder), asc(advertisementsTable.id));
  return res.json(rows);
});

router.post("/ads", requireAdmin, async (req: any, res: any) => {
  try {
    const { title, imageUrl, linkUrl, placement, active, sortOrder } = req.body ?? {};
    if (!title || typeof title !== "string") return res.status(400).json({ error: "title required" });
    const created = await db
      .insert(advertisementsTable)
      .values({
        title,
        imageUrl: imageUrl ?? null,
        linkUrl: linkUrl ?? null,
        placement: placement ?? "sidebar",
        active: active ?? true,
        sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
      })
      .returning();
    return res.status(201).json(created[0]);
  } catch (err) {
    req.log?.error(err, "Failed to create ad");
    return res.status(500).json({ error: "Failed to create ad" });
  }
});

router.put("/ads/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const { title, imageUrl, linkUrl, placement, active, sortOrder } = req.body ?? {};
    const updated = await db
      .update(advertisementsTable)
      .set({
        ...(title !== undefined ? { title } : {}),
        ...(imageUrl !== undefined ? { imageUrl } : {}),
        ...(linkUrl !== undefined ? { linkUrl } : {}),
        ...(placement !== undefined ? { placement } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
      })
      .where(eq(advertisementsTable.id, id))
      .returning();
    if (updated.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json(updated[0]);
  } catch (err) {
    req.log?.error(err, "Failed to update ad");
    return res.status(500).json({ error: "Failed to update ad" });
  }
});

router.delete("/ads/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    await db.delete(advertisementsTable).where(eq(advertisementsTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    req.log?.error(err, "Failed to delete ad");
    return res.status(500).json({ error: "Failed to delete ad" });
  }
});

// ---- Custom pages ----

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || `page-${Date.now()}`;
}

router.get("/pages", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(customPagesTable)
      .where(eq(customPagesTable.published, true))
      .orderBy(asc(customPagesTable.sortOrder), asc(customPagesTable.id));
    return res.json(rows);
  } catch (err) {
    (res.req as any).log?.error(err, "Failed to load pages");
    return res.json([]);
  }
});

router.get("/pages/all", requireAdmin, async (_req: any, res: any) => {
  const rows = await db
    .select()
    .from(customPagesTable)
    .orderBy(asc(customPagesTable.sortOrder), asc(customPagesTable.id));
  return res.json(rows);
});

router.get("/pages/by-slug/:slug", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(customPagesTable)
      .where(and(eq(customPagesTable.slug, req.params.slug), eq(customPagesTable.published, true)))
      .limit(1);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json(rows[0]);
  } catch (err) {
    (res.req as any).log?.error(err, "Failed to load page");
    return res.status(500).json({ error: "Failed to load page" });
  }
});

router.post("/pages", requireAdmin, async (req: any, res: any) => {
  try {
    const { title, titleMl, content, slug, published, showInNav, sortOrder } = req.body ?? {};
    if (!title || typeof title !== "string") return res.status(400).json({ error: "title required" });
    const finalSlug = slugify(slug && typeof slug === "string" ? slug : title);
    const created = await db
      .insert(customPagesTable)
      .values({
        slug: finalSlug,
        title,
        titleMl: titleMl ?? null,
        content: cleanHtml(content),
        published: published ?? true,
        showInNav: showInNav ?? true,
        sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
      })
      .returning();
    return res.status(201).json(created[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "A page with this slug already exists" });
    req.log?.error(err, "Failed to create page");
    return res.status(500).json({ error: "Failed to create page" });
  }
});

router.put("/pages/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const { title, titleMl, content, slug, published, showInNav, sortOrder } = req.body ?? {};
    const updated = await db
      .update(customPagesTable)
      .set({
        ...(title !== undefined ? { title } : {}),
        ...(titleMl !== undefined ? { titleMl } : {}),
        ...(content !== undefined ? { content: cleanHtml(content) } : {}),
        ...(slug !== undefined ? { slug: slugify(slug) } : {}),
        ...(published !== undefined ? { published } : {}),
        ...(showInNav !== undefined ? { showInNav } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(customPagesTable.id, id))
      .returning();
    if (updated.length === 0) return res.status(404).json({ error: "Not found" });
    return res.json(updated[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "A page with this slug already exists" });
    req.log?.error(err, "Failed to update page");
    return res.status(500).json({ error: "Failed to update page" });
  }
});

router.delete("/pages/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    await db.delete(customPagesTable).where(eq(customPagesTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    req.log?.error(err, "Failed to delete page");
    return res.status(500).json({ error: "Failed to delete page" });
  }
});

export default router;
