import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from "vitest";

// Hoisted mock fns so the (hoisted) vi.mock factories can reference them.
const { fetchCategoryItemsMock, createMock } = vi.hoisted(() => ({
  fetchCategoryItemsMock: vi.fn(),
  createMock: vi.fn(),
}));

// Keep the rest of news-sources real (CATEGORY_LABELS, types, etc.) and only
// replace the network-bound fetchCategoryItems so generateAiNews runs offline.
vi.mock("./news-sources.js", async (importActual) => {
  const actual = await importActual<typeof import("./news-sources.js")>();
  return { ...actual, fetchCategoryItems: fetchCategoryItemsMock };
});

// Replace the OpenAI client so reviewAndTranslate never makes a real API call.
vi.mock("./openai.js", () => ({
  getOpenAi: () => ({ chat: { completions: { create: createMock } } }),
  AI_NEWS_MODEL: "test-model",
  isOpenAiConfigured: () => true,
}));

import { db, aiNewsTable, pool } from "@workspace/db";
import { inArray, like } from "drizzle-orm";
import { generateAiNews, isBlocked } from "./ai-news-service";
import type { NewsCategory, RawNewsItem } from "./news-sources.js";

// Unique per-run prefix so we only ever touch rows this test created and so
// reruns never collide on the unique sourceUrl index.
const RUN = `__gen_test__${Date.now()}_${Math.random().toString(36).slice(2)}`;
const link = (name: string) => `https://example.test/${RUN}/${name}`;

// Distinct English titles so the mocked OpenAI client can return a tailored
// review per source item.
const BLOCKED_TITLE = "Kuwait ministry announces new visa rule";
const DISALLOWED_TITLE = "Some Rejected Story Headline";
const ALLOWED_TITLE = "Local Team Wins The Championship";
const HTML_TITLE = "Story With Markup In Output";

function makeItems(): RawNewsItem[] {
  return [
    {
      category: "international",
      title: BLOCKED_TITLE,
      snippet: "Kuwait ministry details.",
      link: link("blocked"),
      source: "BlockedSource",
      publishedAt: new Date("2025-01-01T00:00:00.000Z"),
    },
    {
      category: "international",
      title: DISALLOWED_TITLE,
      snippet: "Something the AI editor rejects.",
      link: link("disallowed"),
      source: "RejectSource",
      publishedAt: new Date("2025-01-02T00:00:00.000Z"),
    },
    {
      category: "international",
      title: ALLOWED_TITLE,
      snippet: "A clean public-interest sports story.",
      link: link("allowed"),
      source: "GoodSource",
      publishedAt: new Date("2025-01-03T00:00:00.000Z"),
      imageUrl: "https://example.test/photo.jpg",
    },
    {
      category: "international",
      title: HTML_TITLE,
      snippet: "Model returns HTML which must be sanitized.",
      link: link("html"),
      source: "HtmlSource",
      publishedAt: new Date("2025-01-04T00:00:00.000Z"),
    },
  ];
}

beforeEach(() => {
  // Only the "international" category yields items; every other category is
  // empty so the run processes exactly the four items above.
  fetchCategoryItemsMock.mockImplementation(async (category: NewsCategory) =>
    category === "international" ? makeItems() : [],
  );

  createMock.mockImplementation(async (args: any) => {
    const userMsg: string =
      args.messages.find((m: any) => m.role === "user")?.content ?? "";
    let payload: Record<string, unknown>;
    if (userMsg.includes(ALLOWED_TITLE)) {
      payload = {
        allowed: true,
        reason: "genuine public-interest news",
        titleMl: "പ്രാദേശിക ടീം കിരീടം നേടി",
        summaryMl: "ടീം മത്സരത്തിൽ വിജയിച്ചു",
        contentMl: "പ്രാദേശിക ടീം ഫൈനലിൽ വിജയിച്ച് കിരീടം നേടി.",
      };
    } else if (userMsg.includes(HTML_TITLE)) {
      payload = {
        allowed: true,
        reason: "ok",
        titleMl: "<b>വാർത്ത തലക്കെട്ട്</b>",
        summaryMl: "<i>സംഗ്രഹം</i>",
        contentMl: "<script>alert(1)</script>ശുദ്ധമായ ഉള്ളടക്കം",
      };
    } else if (userMsg.includes(DISALLOWED_TITLE)) {
      payload = { allowed: false, reason: "rejected by editor" };
    } else {
      // Should not be reached: blocked items never make it to the model.
      payload = { allowed: false, reason: "unexpected" };
    }
    return { choices: [{ message: { content: JSON.stringify(payload) } }] };
  });
});

afterEach(async () => {
  await db.delete(aiNewsTable).where(like(aiNewsTable.sourceUrl, `%${RUN}%`));
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe("isBlocked", () => {
  it("blocks representative banned phrases case-insensitively", () => {
    expect(isBlocked("Breaking: Kuwait Ministry issues statement")).toBe(true);
    expect(isBlocked("report on KUWAIT VISA changes")).toBe(true);
    expect(isBlocked("A story about Money Laundering ring")).toBe(true);
    expect(isBlocked("this is a HOAX")).toBe(true);
    expect(isBlocked("how to make a BOMB tutorial")).toBe(true);
  });

  it("passes clean text through", () => {
    expect(isBlocked("Kerala team wins the cricket final")).toBe(false);
    expect(isBlocked("New health guidelines for monsoon season")).toBe(false);
    expect(isBlocked("")).toBe(false);
  });
});

describe("generateAiNews", () => {
  it("skips blocked source items, drops non-allowed reviews, and inserts allowed items with fields mapped", async () => {
    const inserted = await generateAiNews();

    // Only the allowed item and the HTML item (also allowed:true) are inserted.
    expect(inserted).toBe(2);

    // The blocked item must never reach the model.
    const reviewedTitles = createMock.mock.calls.map(
      (c: any) => c[0].messages.find((m: any) => m.role === "user")?.content ?? "",
    );
    expect(reviewedTitles.some((t: string) => t.includes(BLOCKED_TITLE))).toBe(false);
    // The other three items were sent for review.
    expect(reviewedTitles.some((t: string) => t.includes(DISALLOWED_TITLE))).toBe(true);
    expect(reviewedTitles.some((t: string) => t.includes(ALLOWED_TITLE))).toBe(true);
    expect(reviewedTitles.some((t: string) => t.includes(HTML_TITLE))).toBe(true);

    const rows = await db
      .select()
      .from(aiNewsTable)
      .where(like(aiNewsTable.sourceUrl, `%${RUN}%`));
    const byUrl = new Map(rows.map((r) => [r.sourceUrl, r]));

    // Blocked and disallowed items are absent.
    expect(byUrl.has(link("blocked"))).toBe(false);
    expect(byUrl.has(link("disallowed"))).toBe(false);

    // The allowed item is persisted with every field mapped correctly.
    const allowed = byUrl.get(link("allowed"));
    expect(allowed).toBeDefined();
    expect(allowed!.category).toBe("international");
    expect(allowed!.titleMl).toBe("പ്രാദേശിക ടീം കിരീടം നേടി");
    expect(allowed!.titleEn).toBe(ALLOWED_TITLE);
    expect(allowed!.summaryMl).toBe("ടീം മത്സരത്തിൽ വിജയിച്ചു");
    expect(allowed!.contentMl).toBe("പ്രാദേശിക ടീം ഫൈനലിൽ വിജയിച്ച് കിരീടം നേടി.");
    expect(allowed!.sourceName).toBe("GoodSource");
    expect(allowed!.imageUrl).toBe("https://example.test/photo.jpg");
    expect(allowed!.publishedAt?.getTime()).toBe(
      new Date("2025-01-03T00:00:00.000Z").getTime(),
    );
  });

  it("sanitizes HTML/markup out of model output before persistence", async () => {
    await generateAiNews();

    const [htmlRow] = await db
      .select()
      .from(aiNewsTable)
      .where(inArray(aiNewsTable.sourceUrl, [link("html")]));

    expect(htmlRow).toBeDefined();
    // No angle brackets / tags survive into the stored content.
    expect(htmlRow.titleMl).not.toMatch(/[<>]/);
    expect(htmlRow.summaryMl ?? "").not.toMatch(/[<>]/);
    expect(htmlRow.contentMl).not.toMatch(/[<>]/);
    // Tags are stripped but the inner Malayalam text is preserved.
    expect(htmlRow.titleMl).toBe("വാർത്ത തലക്കെട്ട്");
    expect(htmlRow.contentMl).toContain("ശുദ്ധമായ ഉള്ളടക്കം");
    expect(htmlRow.contentMl).not.toContain("script");
  });

  it("drops feed-supplied media that isn't a safe http(s) image", async () => {
    const MEDIA_TITLE = "Story With Unsafe Media URLs";
    // A single allowed item carrying a hostile non-http(s) image. It must be
    // nulled at the publish boundary. AI news is photos-only — no video.
    fetchCategoryItemsMock.mockImplementation(async (category: NewsCategory) =>
      category === "international"
        ? [
            {
              category: "international",
              title: MEDIA_TITLE,
              snippet: "A clean story but with attacker-controlled media URLs.",
              link: link("badmedia"),
              source: "MediaSource",
              publishedAt: new Date("2025-01-05T00:00:00.000Z"),
              imageUrl: "javascript:alert(1)",
            },
          ]
        : [],
    );
    createMock.mockImplementation(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              allowed: true,
              reason: "ok",
              titleMl: "തലക്കെട്ട്",
              summaryMl: "സംഗ്രഹം",
              contentMl: "ശുദ്ധമായ ഉള്ളടക്കം",
            }),
          },
        },
      ],
    }));

    const inserted = await generateAiNews();
    expect(inserted).toBe(1);

    const [row] = await db
      .select()
      .from(aiNewsTable)
      .where(inArray(aiNewsTable.sourceUrl, [link("badmedia")]));
    expect(row).toBeDefined();
    // Story text still published; only the unsafe media was stripped.
    expect(row.titleMl).toBe("തലക്കെട്ട്");
    expect(row.imageUrl).toBeNull();
  });

  it("aborts the whole cycle on the first OpenAI 401 instead of retrying every item", async () => {
    // Simulate an invalid/expired key: every model call rejects with a 401.
    // generateAiNews must stop after the first one, not hammer the API for each
    // of the remaining items (which previously caused a 401 log storm in prod).
    const authError = Object.assign(new Error("401 status code (no body)"), {
      status: 401,
    });
    createMock.mockRejectedValue(authError);

    const inserted = await generateAiNews();

    expect(inserted).toBe(0);
    // Only ONE model call was attempted before bailing out — not one per item.
    expect(createMock).toHaveBeenCalledTimes(1);

    // Nothing was persisted for this run.
    const rows = await db
      .select()
      .from(aiNewsTable)
      .where(like(aiNewsTable.sourceUrl, `%${RUN}%`));
    expect(rows.length).toBe(0);
  });

  it("drops a feed item whose source link is not http(s) before it is reviewed or published", async () => {
    // The source link becomes a public <a href>, so a javascript: link must never
    // reach the DB. It is rejected up front — before any (paid) AI review call.
    fetchCategoryItemsMock.mockImplementation(async (category: NewsCategory) =>
      category === "international"
        ? [
            {
              category: "international",
              title: "Story With A Hostile Source Link",
              snippet: "Otherwise clean, but the link is a script URL.",
              link: "javascript:alert(document.cookie)",
              source: "BadLinkSource",
              publishedAt: new Date("2025-01-07T00:00:00.000Z"),
              imageUrl: "https://example.test/ok.jpg",
            },
          ]
        : [],
    );

    const inserted = await generateAiNews();
    expect(inserted).toBe(0);
    // Dropped before the review call, so no model request was made for it.
    expect(createMock).not.toHaveBeenCalled();
  });
});
