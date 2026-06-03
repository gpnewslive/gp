import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  db,
  articlesTable,
  breakingNewsTable,
  adminSessionsTable,
  pool,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import app from "../app.js";

// Locks in the editorial access-control boundary (Task: Editorial Access Control
// and Publication State):
//  - Unpublished/expired articles and the admin dashboard must never be exposed
//    to anonymous callers (information disclosure of embargoed editorial state).
//  - Article and breaking-news mutations are admin-only; an unauthenticated
//    caller must not be able to create, edit, or delete site content.

let server: Server;
let baseUrl: string;
let draftId: number;
let publishedId: number;
let breakingId: number;
let adminToken: string;

const MARK = `__test_access_${Date.now()}`;

beforeAll(async () => {
  const [draft] = await db
    .insert(articlesTable)
    .values({
      title: `${MARK}-draft`,
      content: "secret draft body",
      category: "international",
      status: "draft",
    })
    .returning({ id: articlesTable.id });
  draftId = draft.id;

  const [pub] = await db
    .insert(articlesTable)
    .values({
      title: `${MARK}-published`,
      content: "public body",
      category: "international",
      status: "published",
    })
    .returning({ id: articlesTable.id });
  publishedId = pub.id;

  const [brk] = await db
    .insert(breakingNewsTable)
    .values({ text: `${MARK}-breaking` })
    .returning({ id: breakingNewsTable.id });
  breakingId = brk.id;

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
  if (draftId) await db.delete(articlesTable).where(eq(articlesTable.id, draftId));
  if (publishedId) await db.delete(articlesTable).where(eq(articlesTable.id, publishedId));
  if (breakingId) await db.delete(breakingNewsTable).where(eq(breakingNewsTable.id, breakingId));
  if (adminToken) await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, adminToken));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("editorial information disclosure", () => {
  it("hides a draft article from anonymous callers (404), like a missing one", async () => {
    const res = await fetch(`${baseUrl}/api/articles/${draftId}`);
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(raw).not.toContain("secret draft body");
  });

  it("returns the draft to a valid admin", async () => {
    const res = await fetch(`${baseUrl}/api/articles/${draftId}`, {
      headers: { "x-admin-token": adminToken },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: number; status: string };
    expect(json.id).toBe(draftId);
    expect(json.status).toBe("draft");
  });

  it("still serves published articles to anonymous callers", async () => {
    const res = await fetch(`${baseUrl}/api/articles/${publishedId}`);
    expect(res.status).toBe(200);
  });

  it("requires admin for the dashboard stats", async () => {
    const anon = await fetch(`${baseUrl}/api/stats/dashboard`);
    expect(anon.status).toBe(401);

    const admin = await fetch(`${baseUrl}/api/stats/dashboard`, {
      headers: { "x-admin-token": adminToken },
    });
    expect(admin.status).toBe(200);
  });
});

describe("editorial mutation authorization", () => {
  it("rejects anonymous article create/update/delete", async () => {
    const create = await fetch(`${baseUrl}/api/articles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "hax",
        content: "hax",
        category: "international",
        status: "published",
      }),
    });
    expect(create.status).toBe(401);

    const patch = await fetch(`${baseUrl}/api/articles/${publishedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "defaced" }),
    });
    expect(patch.status).toBe(401);

    const del = await fetch(`${baseUrl}/api/articles/${publishedId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(401);

    // The published article must be untouched after the rejected mutations.
    const still = await db
      .select({ title: articlesTable.title })
      .from(articlesTable)
      .where(eq(articlesTable.id, publishedId));
    expect(still[0]?.title).toBe(`${MARK}-published`);
  });

  it("rejects anonymous breaking-news create/delete", async () => {
    const create = await fetch(`${baseUrl}/api/breaking-news`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fake urgent ticker" }),
    });
    expect(create.status).toBe(401);

    const del = await fetch(`${baseUrl}/api/breaking-news/${breakingId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(401);
  });
});
