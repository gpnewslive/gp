import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
  db,
  aiNewsTable,
  adminSessionsTable,
  pool,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import aiNewsRouter from "./ai-news.js";

// Regression coverage for the photos-only contract: AI news no longer supports
// video. A `videoUrl` field in a PATCH payload must be silently ignored — never
// persisted and never reflected back in the response.

const TEST_MARKER = "__ai_news_patch_test__";
const ADMIN_TOKEN = `test-token-${randomBytes(8).toString("hex")}`;
const createdNewsIds: number[] = [];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await db.insert(adminSessionsTable).values({
    token: ADMIN_TOKEN,
    username: "test-admin",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const app = express();
  app.use(express.json());
  app.use("/api", aiNewsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (createdNewsIds.length > 0) {
    await db.delete(aiNewsTable).where(inArray(aiNewsTable.id, createdNewsIds));
    createdNewsIds.length = 0;
  }
});

afterAll(async () => {
  await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, ADMIN_TOKEN));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function seedNews(): Promise<number> {
  const [row] = await db
    .insert(aiNewsTable)
    .values({
      category: "international",
      titleMl: "ടെസ്റ്റ് വാർത്ത",
      contentMl: "ടെസ്റ്റ് ഉള്ളടക്കം",
      sourceName: TEST_MARKER,
    })
    .returning({ id: aiNewsTable.id });
  createdNewsIds.push(row.id);
  return row.id;
}

describe("PATCH /api/ai-news/:id is photos-only", () => {
  it("ignores a videoUrl payload — never persisted, never returned", async () => {
    const id = await seedNews();

    const res = await fetch(`${baseUrl}/api/ai-news/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: JSON.stringify({
        titleMl: "പുതുക്കിയ തലക്കെട്ട്",
        videoUrl: "https://www.youtube.com/embed/abc123",
        imageUrl: "https://example.test/photo.jpg",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // The valid fields are applied...
    expect(body.titleMl).toBe("പുതുക്കിയ തലക്കെട്ട്");
    expect(body.imageUrl).toBe("https://example.test/photo.jpg");
    // ...but videoUrl is not part of the contract at all.
    expect(body).not.toHaveProperty("videoUrl");

    // And nothing video-shaped was persisted.
    const [persisted] = await db
      .select()
      .from(aiNewsTable)
      .where(eq(aiNewsTable.id, id))
      .limit(1);
    expect(persisted).not.toHaveProperty("videoUrl");
    expect(JSON.stringify(persisted)).not.toContain("youtube.com");
  });

  it("rejects a payload that has only a videoUrl with no valid fields", async () => {
    const id = await seedNews();

    const res = await fetch(`${baseUrl}/api/ai-news/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: JSON.stringify({
        videoUrl: "https://www.youtube.com/embed/abc123",
      }),
    });

    // videoUrl isn't a recognized field, so there is nothing to update.
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/no valid fields/i);
  });

  it("requires an admin token", async () => {
    const id = await seedNews();

    const res = await fetch(`${baseUrl}/api/ai-news/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ titleMl: "no auth" }),
    });

    expect(res.status).toBe(401);
  });
});
