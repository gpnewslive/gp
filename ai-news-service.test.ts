import { describe, it, expect, afterEach, afterAll, vi } from "vitest";

// Stub the external backup side-effects so the purge test never touches Google
// Drive or SMTP. The DB archive/delete flow below runs against the real DB.
vi.mock("./drive-backup.js", () => ({
  backupNewsToDrive: vi.fn(async () => "test-drive-file-id"),
}));
vi.mock("./email.js", () => ({
  sendBackupEmail: vi.fn(async () => false),
}));

import { db, aiNewsTable, aiNewsArchiveTable, pool } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { purgeOldAiNews } from "./ai-news-service";

// Unique marker so we only ever touch rows this test created.
const TEST_MARKER = "__purge_test__";
const createdNewsIds: number[] = [];

afterEach(async () => {
  if (createdNewsIds.length > 0) {
    await db.delete(aiNewsTable).where(inArray(aiNewsTable.id, createdNewsIds));
    await db
      .delete(aiNewsArchiveTable)
      .where(
        inArray(
          aiNewsArchiveTable.originalId,
          createdNewsIds.map((id) => String(id)),
        ),
      );
    createdNewsIds.length = 0;
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

async function seedNews(values: Partial<typeof aiNewsTable.$inferInsert>) {
  const [row] = await db
    .insert(aiNewsTable)
    .values({
      category: "international",
      titleMl: "ടെസ്റ്റ് വാർത്ത",
      contentMl: "ടെസ്റ്റ് ഉള്ളടക്കം",
      sourceName: TEST_MARKER,
      ...values,
    })
    .returning({ id: aiNewsTable.id });
  createdNewsIds.push(row.id);
  return row.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

describe("purgeOldAiNews", () => {
  it("archives >24h items and deletes them, leaving fresh ones", async () => {
    const oldId = await seedNews({
      createdAt: hoursAgo(25),
      imageUrl: "https://example.test/photo.jpg",
      sourceUrl: `${TEST_MARKER}-old`,
    });
    const freshId = await seedNews({
      createdAt: hoursAgo(1),
      sourceUrl: `${TEST_MARKER}-fresh`,
    });

    // purgeOldAiNews operates on the whole table, so other stale rows (or a
    // concurrently-running scheduler against the shared dev DB) may also be
    // purged. Assert it removed at least our old item; the per-id checks below
    // prove the exact behaviour without depending on a global count.
    const purged = await purgeOldAiNews();
    expect(purged).toBeGreaterThanOrEqual(1);

    // Old item is gone from the live table; fresh one remains.
    const live = await db
      .select({ id: aiNewsTable.id })
      .from(aiNewsTable)
      .where(inArray(aiNewsTable.id, createdNewsIds));
    const liveIds = live.map((r) => r.id);
    expect(liveIds).not.toContain(oldId);
    expect(liveIds).toContain(freshId);

    // The archived row mirrors the original, including imageUrl.
    const archived = await db
      .select()
      .from(aiNewsArchiveTable)
      .where(eq(aiNewsArchiveTable.originalId, String(oldId)));
    expect(archived).toHaveLength(1);
    expect(archived[0].imageUrl).toBe("https://example.test/photo.jpg");
    expect(archived[0].titleMl).toBe("ടെസ്റ്റ് വാർത്ത");
  });

  it("does not delete anything when the archive insert fails", async () => {
    const oldId = await seedNews({
      createdAt: hoursAgo(25),
      sourceUrl: `${TEST_MARKER}-archive-fail`,
    });

    // Force the archive insert to blow up.
    const boom = new Error("archive insert failed");
    vi.spyOn(db, "insert").mockImplementation(() => {
      throw boom;
    });

    const purged = await purgeOldAiNews();
    expect(purged).toBe(0);

    vi.restoreAllMocks();

    // The original must still be present since archiving failed.
    const live = await db
      .select({ id: aiNewsTable.id })
      .from(aiNewsTable)
      .where(eq(aiNewsTable.id, oldId));
    expect(live).toHaveLength(1);
  });

  it("returns 0 and archives nothing when there are no items older than 24h", async () => {
    await seedNews({ createdAt: hoursAgo(1), sourceUrl: `${TEST_MARKER}-young` });

    const purged = await purgeOldAiNews();
    expect(purged).toBe(0);
  });
});
