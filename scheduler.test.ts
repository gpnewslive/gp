import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { db, articlesTable, pool } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { processScheduledArticles } from "./scheduler";

// Marker so we only ever read/clean rows this test created, never real content.
const TEST_AUTHOR = "__job_test__";
const createdIds: number[] = [];

afterEach(async () => {
  if (createdIds.length > 0) {
    await db.delete(articlesTable).where(inArray(articlesTable.id, createdIds));
    createdIds.length = 0;
  }
  vi.restoreAllMocks();
});

// Close the shared pool so vitest can exit cleanly after the suite.
afterAll(async () => {
  await pool.end();
});

async function seedArticle(values: Partial<typeof articlesTable.$inferInsert>) {
  const [row] = await db
    .insert(articlesTable)
    .values({
      title: "job test article",
      content: "body",
      category: "international",
      author: TEST_AUTHOR,
      ...values,
    })
    .returning({ id: articlesTable.id });
  createdIds.push(row.id);
  return row.id;
}

describe("processScheduledArticles happy path", () => {
  it("publishes due scheduled articles and archives expired published ones", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);

    const dueScheduledId = await seedArticle({ status: "scheduled", publishAt: past });
    const notDueScheduledId = await seedArticle({ status: "scheduled", publishAt: future });
    const expiredId = await seedArticle({ status: "published", featured: true, expireAt: past });
    const liveId = await seedArticle({ status: "published", featured: true, expireAt: future });

    await processScheduledArticles();

    const rows = await db
      .select({
        id: articlesTable.id,
        status: articlesTable.status,
        featured: articlesTable.featured,
      })
      .from(articlesTable)
      .where(inArray(articlesTable.id, createdIds));
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Due scheduled article goes live.
    expect(byId.get(dueScheduledId)?.status).toBe("published");
    // Scheduled for the future stays scheduled.
    expect(byId.get(notDueScheduledId)?.status).toBe("scheduled");
    // Expired published article is archived and de-featured.
    expect(byId.get(expiredId)?.status).toBe("archived");
    expect(byId.get(expiredId)?.featured).toBe(false);
    // Still-live published article is untouched.
    expect(byId.get(liveId)?.status).toBe("published");
    expect(byId.get(liveId)?.featured).toBe(true);
  });
});

// The job runs from BOTH the in-process cron and the standalone Scheduled
// Deployment, with no advisory lock — it relies purely on idempotent guarded
// UPDATEs. These tests assert that running it twice in a row, and concurrently,
// converges to the same correct end state with no double-publishing or skips.
describe("processScheduledArticles idempotency & concurrency", () => {
  it("produces the same stable end state when run twice in a row", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);

    const dueScheduledId = await seedArticle({ status: "scheduled", publishAt: past });
    const notDueScheduledId = await seedArticle({ status: "scheduled", publishAt: future });
    const expiredId = await seedArticle({ status: "published", featured: true, expireAt: past });
    const liveId = await seedArticle({ status: "published", featured: true, expireAt: future });

    // Two sequential passes, as if cron and the scheduled job both fired.
    await processScheduledArticles();
    await processScheduledArticles();

    const rows = await db
      .select({
        id: articlesTable.id,
        status: articlesTable.status,
        featured: articlesTable.featured,
      })
      .from(articlesTable)
      .where(inArray(articlesTable.id, createdIds));
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(dueScheduledId)?.status).toBe("published");
    expect(byId.get(notDueScheduledId)?.status).toBe("scheduled");
    expect(byId.get(expiredId)?.status).toBe("archived");
    expect(byId.get(expiredId)?.featured).toBe(false);
    expect(byId.get(liveId)?.status).toBe("published");
    expect(byId.get(liveId)?.featured).toBe(true);
  });

  it("does not re-publish a manually-archived article on a second pass", async () => {
    const past = new Date(Date.now() - 60_000);

    // A scheduled article that becomes due; gets published on pass one.
    const dueScheduledId = await seedArticle({ status: "scheduled", publishAt: past });

    await processScheduledArticles();
    expect(
      (
        await db
          .select({ status: articlesTable.status })
          .from(articlesTable)
          .where(inArray(articlesTable.id, [dueScheduledId]))
      )[0]?.status,
    ).toBe("published");

    // Simulate an admin (or the other server) archiving it in between passes.
    await db
      .update(articlesTable)
      .set({ status: "archived" })
      .where(inArray(articlesTable.id, [dueScheduledId]));

    // A second pass must not resurrect it: its publishAt is in the past but it
    // is no longer "scheduled", so the guarded UPDATE skips it.
    await processScheduledArticles();

    const [row] = await db
      .select({ status: articlesTable.status })
      .from(articlesTable)
      .where(inArray(articlesTable.id, [dueScheduledId]));
    expect(row?.status).toBe("archived");
  });

  it("converges correctly when two passes run concurrently", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);

    const dueScheduledId = await seedArticle({ status: "scheduled", publishAt: past });
    const notDueScheduledId = await seedArticle({ status: "scheduled", publishAt: future });
    const expiredId = await seedArticle({ status: "published", featured: true, expireAt: past });
    const liveId = await seedArticle({ status: "published", featured: true, expireAt: future });

    // Both servers fire at the same instant. The guarded UPDATEs are safe to
    // run concurrently (Postgres row locking serializes the writes).
    await Promise.all([processScheduledArticles(), processScheduledArticles()]);

    const rows = await db
      .select({
        id: articlesTable.id,
        status: articlesTable.status,
        featured: articlesTable.featured,
      })
      .from(articlesTable)
      .where(inArray(articlesTable.id, createdIds));
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(dueScheduledId)?.status).toBe("published");
    expect(byId.get(notDueScheduledId)?.status).toBe("scheduled");
    expect(byId.get(expiredId)?.status).toBe("archived");
    expect(byId.get(expiredId)?.featured).toBe(false);
    expect(byId.get(liveId)?.status).toBe("published");
    expect(byId.get(liveId)?.featured).toBe(true);
  });
});

describe("processScheduledArticles error handling", () => {
  it("rethrows when throwOnError is true so the job can fail loudly", async () => {
    const boom = new Error("db update failed");
    vi.spyOn(db, "update").mockImplementation(() => {
      throw boom;
    });

    await expect(processScheduledArticles({ throwOnError: true })).rejects.toBe(boom);
  });

  it("swallows errors when throwOnError is false (in-process cron behaviour)", async () => {
    vi.spyOn(db, "update").mockImplementation(() => {
      throw new Error("db update failed");
    });

    await expect(processScheduledArticles()).resolves.toBeUndefined();
  });
});
