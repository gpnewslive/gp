import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger";
import { runNewsCycle, processScheduledArticles } from "./lib/scheduler";
import { flushSocialPosts } from "./lib/social";

// Standalone entry point for a Scheduled Deployment. Running this on a guaranteed
// schedule (every 5-15 min) keeps article scheduling and news maintenance working
// even when the autoscale web instance has scaled to zero and the in-process cron
// is not alive. It performs one pass and exits.
//
// 1. processScheduledArticles(): publish due scheduled articles + archive expired
//    ones. Cheap, exact, and idempotent (guarded UPDATEs), so it is safe to run
//    frequently and concurrently with the in-process cron.
// 2. runNewsCycle(): purge >24h news (with backup) and refresh AI news only when
//    stale. We do NOT force generation here so the job stays inexpensive when run
//    on a short interval — the freshness guard (and a Postgres advisory lock)
//    prevents redundant or concurrent news generation.

// Injectable so the exit-code contract can be tested without touching the DB or
// external services. Defaults to the real scheduler functions.
export interface JobDeps {
  processScheduledArticles: typeof processScheduledArticles;
  runNewsCycle: typeof runNewsCycle;
}

const defaultDeps: JobDeps = { processScheduledArticles, runNewsCycle };

// Runs one maintenance pass and returns the process exit code: 0 on success,
// 1 if any step fails. `throwOnError: true` makes the scheduler steps rethrow so
// a failure here surfaces as a non-zero exit (which lets a Scheduled Deployment
// raise an alert) instead of silently doing nothing.
export async function runJob(deps: JobDeps = defaultDeps): Promise<number> {
  logger.info("Scheduled maintenance job starting");
  try {
    await deps.processScheduledArticles({ throwOnError: true });
    await deps.runNewsCycle({ throwOnError: true });
    logger.info("Scheduled maintenance job complete");
    return 0;
  } catch (err) {
    logger.error({ err }, "Scheduled maintenance job failed");
    return 1;
  } finally {
    // Scheduled/AI publishing fires social posts in the background; wait for them
    // to finish before the process exits so they are not cut off mid-request.
    await flushSocialPosts();
  }
}

// Only run (and call process.exit) when this module is the program entry point,
// so importing it from a test does not terminate the test process.
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runJob().then((code) => process.exit(code));
}
