import cron from "node-cron";
import { pool, db, articlesTable } from "@workspace/db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { generateAiNews, purgeOldAiNews, latestNewsAgeMinutes } from "./ai-news-service.js";
import { isNewsAutomationEnabled } from "./automation.js";
import { refreshRates } from "./rates-service.js";
import { postNewsToSocial, articleUrl } from "./social.js";
import { logger } from "./logger.js";

let running = false;

// Constant key for the Postgres advisory lock that guards a news cycle.
const NEWS_CYCLE_LOCK_KEY = 776699;

interface CycleOptions {
  force?: boolean;
  // When true, errors are rethrown after logging so a standalone job can exit
  // with a non-zero status. The in-process cron leaves this false.
  throwOnError?: boolean;
}

// One maintenance cycle: purge >24h news (with backup), then refresh if stale.
export async function runNewsCycle(opts: CycleOptions = {}): Promise<void> {
  const { force = false, throwOnError = false } = opts;

  if (running) {
    logger.info("News cycle already running in this process, skipping");
    return;
  }
  running = true;

  // Cross-process mutual exclusion: hold a session-level advisory lock on a
  // dedicated connection so the in-process cron and the Scheduled Deployment
  // job can never run a cycle (or purge) at the same time.
  const client = await pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [NEWS_CYCLE_LOCK_KEY],
    );
    locked = res.rows[0]?.locked === true;
    if (!locked) {
      logger.info("Another process holds the news-cycle lock, skipping");
      return;
    }

    // Admin master switch: when paused, the automatic cycle does nothing (no
    // purge, no generation) so existing content is frozen until an admin resumes.
    // A forced run (admin "Generate now" / "Run full cycle") bypasses the pause
    // since that is an explicit admin action.
    if (!force && !(await isNewsAutomationEnabled())) {
      logger.info("News automation paused by admin, skipping cycle");
      return;
    }

    await purgeOldAiNews();
    const age = await latestNewsAgeMinutes();
    // Refresh every ~90 min, or immediately if there is no news at all. Kept
    // above ~1h so the freshness guard + advisory lock still prevent runaway
    // generation / token cost under the hourly cron + scheduled job.
    if (force || age === null || age >= 90) {
      await generateAiNews(5);
    } else {
      logger.info({ ageMinutes: Math.round(age) }, "AI news still fresh, skipping generation");
    }
  } catch (err) {
    logger.error({ err }, "News cycle failed");
    if (throwOnError) throw err;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [NEWS_CYCLE_LOCK_KEY]);
      } catch (err) {
        logger.error({ err }, "Failed to release news-cycle lock");
      }
    }
    client.release();
    running = false;
  }
}

// Flip scheduled articles live when their publish time arrives, and archive
// expired ones (clearing featured) so vacated hero/featured slots are filled
// automatically by the next highest-priority article. Public read queries also
// filter on expiry, so this job is a safety net rather than the sole guarantee.
export async function processScheduledArticles(
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  try {
    const now = new Date();
    // RETURNING yields only the rows THIS statement actually flipped. Under
    // concurrent runs (in-process cron + standalone job) a row is promoted by
    // exactly one statement, so each newly published article is posted once.
    const promoted = await db
      .update(articlesTable)
      .set({ status: "published" })
      .where(
        and(
          eq(articlesTable.status, "scheduled"),
          isNotNull(articlesTable.publishAt),
          lte(articlesTable.publishAt, now),
        ),
      )
      .returning();
    for (const a of promoted) {
      postNewsToSocial({
        title: a.title,
        summary: a.summary,
        link: articleUrl(a.id),
        imageUrl: a.imageUrl,
      }).catch((err) => logger.error({ err }, "Social auto-post (scheduled) failed"));
    }
    await db
      .update(articlesTable)
      .set({ status: "archived", featured: false })
      .where(
        and(
          eq(articlesTable.status, "published"),
          isNotNull(articlesTable.expireAt),
          lte(articlesTable.expireAt, now),
        ),
      );
  } catch (err) {
    logger.error({ err }, "Scheduled-article processing failed");
    if (opts.throwOnError) throw err;
  }
}

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  // Run a cycle shortly after boot (covers cold starts on autoscale).
  setTimeout(() => {
    runNewsCycle().catch((err) => logger.error({ err }, "Startup news cycle failed"));
    refreshRates().catch((err) => logger.error({ err }, "Startup rates refresh failed"));
    processScheduledArticles().catch((err) => logger.error({ err }, "Startup scheduled-article processing failed"));
  }, 8000);

  // Hourly tick — the freshness guard limits generation to ~every 2.5-3h.
  cron.schedule("0 * * * *", () => {
    runNewsCycle().catch((err) => logger.error({ err }, "Scheduled news cycle failed"));
    refreshRates().catch((err) => logger.error({ err }, "Scheduled rates refresh failed"));
  });

  // Every 5 minutes: publish due scheduled articles and archive expired ones.
  cron.schedule("*/5 * * * *", () => {
    processScheduledArticles().catch((err) => logger.error({ err }, "Scheduled-article cron failed"));
  });

  logger.info("AI news scheduler started");
}
