import { db, siteSettingsTable } from "@workspace/db";
import { asc } from "drizzle-orm";
import { logger } from "./logger.js";

/**
 * Admin master switch for ALL automatic channel processes. When ON (default)
 * the channel runs everything automatically 24/7: AI-news collection/translation/
 * refresh (`runNewsCycle`) AND social-media auto-posting (`postNewsToSocial`).
 * When an admin switches it OFF the channel goes "manual" — automatic AI news and
 * automatic social posts both stop, while the public website keeps serving.
 * Manual admin actions (force flag) still work. Reads
 * site_settings.header.automation.newsEnabled. Defaults to ON when unset.
 *
 * Fails OPEN (returns true) if the settings read errors — a transient DB hiccup
 * must never silently stop the channel; only an explicit admin pause does.
 */
export async function isNewsAutomationEnabled(): Promise<boolean> {
  try {
    const rows = await db
      .select()
      .from(siteSettingsTable)
      .orderBy(asc(siteSettingsTable.id))
      .limit(1);
    return rows[0]?.header?.automation?.newsEnabled !== false;
  } catch (err) {
    logger.error({ err }, "Failed to read news-automation flag; assuming enabled");
    return true;
  }
}
