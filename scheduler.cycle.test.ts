import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// Mock the AI-news side of the cycle so no real OpenAI/RSS calls happen and we
// can drive the freshness gate deterministically. `runNewsCycle` still uses the
// real `pool` for its advisory lock, so this talks to the database.
vi.mock("./ai-news-service.js", () => ({
  generateAiNews: vi.fn(async () => 0),
  purgeOldAiNews: vi.fn(async () => 0),
  latestNewsAgeMinutes: vi.fn(async () => null),
}));

// Mock the admin automation switch so we can drive the paused/running gate
// without writing to site_settings. Defaults to enabled before each test.
vi.mock("./automation.js", () => ({
  isNewsAutomationEnabled: vi.fn(async () => true),
}));

import { pool } from "@workspace/db";
import { runNewsCycle } from "./scheduler";
import {
  generateAiNews,
  purgeOldAiNews,
  latestNewsAgeMinutes,
} from "./ai-news-service.js";
import { isNewsAutomationEnabled } from "./automation.js";

const generateMock = vi.mocked(generateAiNews);
const purgeMock = vi.mocked(purgeOldAiNews);
const ageMock = vi.mocked(latestNewsAgeMinutes);
const automationMock = vi.mocked(isNewsAutomationEnabled);

beforeEach(() => {
  // clearAllMocks (below) clears calls but not implementations set via
  // mockResolvedValue, so re-assert the enabled default before every test.
  automationMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe("runNewsCycle freshness gate", () => {
  it("always purges old news first", async () => {
    ageMock.mockResolvedValue(60);

    await runNewsCycle();

    expect(purgeMock).toHaveBeenCalledOnce();
  });

  it("skips generation when news is fresh (age < 90 min)", async () => {
    ageMock.mockResolvedValue(60);

    await runNewsCycle();

    expect(generateMock).not.toHaveBeenCalled();
  });

  it("generates when news is stale (age >= 90 min)", async () => {
    ageMock.mockResolvedValue(200);

    await runNewsCycle();

    expect(generateMock).toHaveBeenCalledOnce();
  });

  it("generates at exactly the 90-minute threshold", async () => {
    ageMock.mockResolvedValue(90);

    await runNewsCycle();

    expect(generateMock).toHaveBeenCalledOnce();
  });

  it("generates when there is no news at all (age is null)", async () => {
    ageMock.mockResolvedValue(null);

    await runNewsCycle();

    expect(generateMock).toHaveBeenCalledOnce();
  });

  it("generates fresh news when force is true even if news is fresh", async () => {
    ageMock.mockResolvedValue(10);

    await runNewsCycle({ force: true });

    expect(generateMock).toHaveBeenCalledOnce();
  });
});

// Must match NEWS_CYCLE_LOCK_KEY in scheduler.ts. Kept local because the
// constant is intentionally not exported; if it changes there, change it here.
const NEWS_CYCLE_LOCK_KEY = 776699;

describe("runNewsCycle cross-process advisory lock", () => {
  it("skips the whole cycle when another process holds the lock", async () => {
    ageMock.mockResolvedValue(null); // would normally force generation

    // Simulate the other server (cron or scheduled job) holding the lock on a
    // dedicated connection.
    const other = await pool.connect();
    try {
      const acquired = await other.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [NEWS_CYCLE_LOCK_KEY],
      );
      expect(acquired.rows[0]?.locked).toBe(true);

      await runNewsCycle();

      // Lock unavailable => no purge and no generation happened at all.
      expect(purgeMock).not.toHaveBeenCalled();
      expect(generateMock).not.toHaveBeenCalled();
    } finally {
      await other.query("SELECT pg_advisory_unlock($1)", [NEWS_CYCLE_LOCK_KEY]);
      other.release();
    }
  });

  it("releases the lock after a normal cycle so the next process can acquire it", async () => {
    ageMock.mockResolvedValue(60); // fresh, so it purges but doesn't generate

    await runNewsCycle();
    expect(purgeMock).toHaveBeenCalledOnce();

    // A separate connection (the other server) must now be able to take the lock.
    const other = await pool.connect();
    try {
      const res = await other.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [NEWS_CYCLE_LOCK_KEY],
      );
      expect(res.rows[0]?.locked).toBe(true);
    } finally {
      await other.query("SELECT pg_advisory_unlock($1)", [NEWS_CYCLE_LOCK_KEY]);
      other.release();
    }
  });
});

describe("runNewsCycle admin automation switch", () => {
  it("skips purge and generation entirely when automation is paused", async () => {
    automationMock.mockResolvedValue(false);
    ageMock.mockResolvedValue(null); // would normally force generation

    await runNewsCycle();

    expect(purgeMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("still runs a forced cycle even when automation is paused", async () => {
    automationMock.mockResolvedValue(false);
    ageMock.mockResolvedValue(10); // fresh, but force overrides everything

    await runNewsCycle({ force: true });

    expect(purgeMock).toHaveBeenCalledOnce();
    expect(generateMock).toHaveBeenCalledOnce();
  });
});

describe("runNewsCycle error handling", () => {
  it("rethrows when throwOnError is true so a standalone job can fail loudly", async () => {
    const boom = new Error("purge failed");
    purgeMock.mockRejectedValue(boom);

    await expect(runNewsCycle({ throwOnError: true })).rejects.toBe(boom);
  });

  it("swallows errors when throwOnError is false (in-process cron behaviour)", async () => {
    purgeMock.mockRejectedValue(new Error("purge failed"));

    await expect(runNewsCycle()).resolves.toBeUndefined();
  });
});
