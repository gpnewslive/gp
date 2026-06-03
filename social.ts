import { Router } from "express";
import { db, siteSettingsTable, type SocialConfig } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin } from "./admin.js";
import {
  getSocialCredentialStatus,
  getSocialConfig,
  postNewsToSocial,
  aiNewsUrl,
} from "../lib/social.js";

const router = Router();

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

// Current auto-posting toggles + whether each platform's credentials are present.
router.get("/social/status", requireAdmin, async (_req: any, res: any) => {
  const config = await getSocialConfig();
  const credentials = getSocialCredentialStatus();
  return res.json({ config, credentials });
});

// Update the auto-posting toggles (persisted inside site_settings.header.social).
router.put("/social", requireAdmin, async (req: any, res: any) => {
  try {
    const body = req.body ?? {};
    const current = await getSocialConfig();
    const next: SocialConfig = {
      autoFacebook: asBool(body.autoFacebook, current.autoFacebook),
      autoInstagram: asBool(body.autoInstagram, current.autoInstagram),
      autoPostAiNews: asBool(body.autoPostAiNews, current.autoPostAiNews),
    };

    const rows = await db
      .select()
      .from(siteSettingsTable)
      .orderBy(asc(siteSettingsTable.id))
      .limit(1);
    const existing = rows[0];
    const header = { ...(existing?.header ?? {}), social: next } as any;

    if (existing) {
      await db
        .update(siteSettingsTable)
        .set({ header, updatedAt: new Date() })
        .where(eq(siteSettingsTable.id, existing.id));
    } else {
      await db.insert(siteSettingsTable).values({ header, updatedAt: new Date() });
    }
    return res.json({ config: next });
  } catch (err) {
    req.log?.error(err, "Failed to save social settings");
    return res.status(500).json({ error: "Failed to save settings" });
  }
});

// Send a manual test post to verify the credentials/connection are working.
router.post("/social/test", requireAdmin, async (req: any, res: any) => {
  const credentials = getSocialCredentialStatus();
  if (!credentials.facebookConfigured && !credentials.instagramConfigured) {
    return res
      .status(400)
      .json({ error: "No social credentials configured. Add the Facebook/Instagram secrets first." });
  }
  const imageUrl =
    typeof req.body?.imageUrl === "string" && req.body.imageUrl.startsWith("https://")
      ? req.body.imageUrl
      : null;
  const result = await postNewsToSocial(
    {
      title: "GPNEWS — ടെസ്റ്റ് പോസ്റ്റ് / Test post",
      summary: "This is a test post from the GPNEWS admin panel to verify auto-posting.",
      link: aiNewsUrl(),
      imageUrl,
    },
    // Manual admin action: always allowed, even when the channel is paused.
    { force: true },
  );
  return res.json({ result, credentials });
});

export default router;
