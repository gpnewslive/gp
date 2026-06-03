import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the master automation switch so we can drive the paused/running gate.
vi.mock("./automation.js", () => ({
  isNewsAutomationEnabled: vi.fn(async () => true),
}));

// Mock the database so getSocialConfig() returns the built-in defaults
// (autoFacebook/autoInstagram ON) without touching a real Postgres connection.
vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
  siteSettingsTable: { id: {}, header: {} },
}));

import { postNewsToSocial, flushSocialPosts } from "./social";
import { isNewsAutomationEnabled } from "./automation.js";

const automationMock = vi.mocked(isNewsAutomationEnabled);
const fetchMock = vi.fn();

const input = {
  title: "Test headline",
  summary: "Test summary",
  link: "https://gpnews.live/ai-news",
  imageUrl: null,
};

beforeEach(() => {
  automationMock.mockResolvedValue(true);
  // Configure Facebook only (keep Instagram unconfigured to keep assertions simple).
  process.env.FB_PAGE_ID = "test-page";
  process.env.FB_PAGE_ACCESS_TOKEN = "test-token";
  delete process.env.IG_BUSINESS_ID;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "123" }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.FB_PAGE_ID;
  delete process.env.FB_PAGE_ACCESS_TOKEN;
});

describe("postNewsToSocial master automation gate", () => {
  it("posts automatically when the channel is running", async () => {
    automationMock.mockResolvedValue(true);

    const result = await postNewsToSocial(input);
    await flushSocialPosts();

    expect(fetchMock).toHaveBeenCalled();
    expect(result.facebook).toBe(true);
  });

  it("skips all posting when the channel is paused (no force)", async () => {
    automationMock.mockResolvedValue(false);

    const result = await postNewsToSocial(input);
    await flushSocialPosts();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ facebook: false, instagram: false });
  });

  it("a forced manual post bypasses the pause gate and still publishes", async () => {
    automationMock.mockResolvedValue(false);

    const result = await postNewsToSocial(input, { force: true });
    await flushSocialPosts();

    expect(fetchMock).toHaveBeenCalled();
    expect(result.facebook).toBe(true);
  });
});
