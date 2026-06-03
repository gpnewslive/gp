import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted mocks referenced by the (hoisted) vi.mock factories below.
const { parseUrlMock, lookupMock } = vi.hoisted(() => ({
  parseUrlMock: vi.fn(),
  lookupMock: vi.fn(),
}));

// Replace the RSS parser so fetchCategoryItems gets controlled feed items
// instead of hitting the network. Only parseURL is exercised.
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = parseUrlMock;
  },
}));

// Mock DNS so assertPublicHttpUrl resolves hostnames to addresses we control,
// letting us exercise the public-vs-private (SSRF) branch deterministically.
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { fetchCategoryItems } from "./news-sources";

// hostname -> resolved IP; default is a public address so fetches proceed.
let dnsMap: Record<string, string>;
const fetchMock = vi.fn();

// Build a fake fetch Response with just the surface fetchOgMedia touches.
function makeResponse(
  body: ReadableStream<Uint8Array> | null,
  opts: { status?: number; contentType?: string | null; location?: string } = {},
) {
  const status = opts.status ?? 200;
  const headers = new Map<string, string>();
  if (opts.contentType !== null) headers.set("content-type", opts.contentType ?? "text/html; charset=utf-8");
  if (opts.location) headers.set("location", opts.location);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body,
  };
}

function streamFromString(str: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(str);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function htmlResponse(html: string, opts: { status?: number; contentType?: string | null } = {}) {
  return makeResponse(streamFromString(html), opts);
}

// A single image-less RSS item that points at the given article URL.
function feedWithLink(url: string) {
  return { title: "Feed", items: [{ title: "Story", link: url, contentSnippet: "snippet" }] };
}

beforeEach(() => {
  dnsMap = {};
  lookupMock.mockImplementation(async (host: string) => [
    { address: dnsMap[host] ?? "93.184.216.34", family: 4 },
  ]);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fetchCategoryItems media selection", () => {
  it("does not fetch the article page when the RSS item already carries an image", async () => {
    parseUrlMock.mockResolvedValue({
      title: "Feed",
      items: [
        {
          title: "Has image",
          link: "https://news.example/a",
          enclosure: { url: "https://img.example/a.jpg", type: "image/jpeg" },
        },
      ],
    });

    const items = await fetchCategoryItems("sports", 8);

    expect(items).toHaveLength(1);
    expect(items[0].imageUrl).toBe("https://img.example/a.jpg");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pulls og:image for an image-less item", async () => {
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/b"));
    fetchMock.mockResolvedValue(
      htmlResponse(
        `<html><head><meta property="og:image" content="https://cdn.example/b.jpg"></head><body></body></html>`,
      ),
    );

    const items = await fetchCategoryItems("sports", 8);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(items[0].imageUrl).toBe("https://cdn.example/b.jpg");
  });

  it("falls back to twitter:image when no og:image is present", async () => {
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/c"));
    fetchMock.mockResolvedValue(
      htmlResponse(
        `<html><head><meta name="twitter:image" content="https://cdn.example/c.png"></head></html>`,
      ),
    );

    const items = await fetchCategoryItems("sports", 8);
    expect(items[0].imageUrl).toBe("https://cdn.example/c.png");
  });

  it("leaves the item text-only when the page has no usable media", async () => {
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/f"));
    fetchMock.mockResolvedValue(
      htmlResponse(`<html><head><title>No media here</title></head><body>text</body></html>`),
    );

    const items = await fetchCategoryItems("sports", 8);
    expect(items[0].imageUrl).toBeUndefined();
  });

  it("ignores non-HTML responses", async () => {
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/g"));
    fetchMock.mockResolvedValue(
      htmlResponse(`{"og:image":"https://cdn.example/g.jpg"}`, { contentType: "application/json" }),
    );

    const items = await fetchCategoryItems("sports", 8);
    expect(items[0].imageUrl).toBeUndefined();
  });

  it("never fetches a link that resolves to a private/internal address (SSRF)", async () => {
    dnsMap["internal.example"] = "10.0.0.5";
    parseUrlMock.mockResolvedValue(feedWithLink("https://internal.example/secret"));

    const items = await fetchCategoryItems("sports", 8);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(items[0].imageUrl).toBeUndefined();
  });

  it("follows a redirect and re-validates each hop before extracting media", async () => {
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/start"));
    fetchMock
      .mockResolvedValueOnce(makeResponse(null, { status: 302, location: "https://final.example/post" }))
      .mockResolvedValueOnce(
        htmlResponse(
          `<html><head><meta property="og:image" content="https://cdn.example/final.jpg"></head></html>`,
        ),
      );

    const items = await fetchCategoryItems("sports", 8);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both the original host and the redirect target were DNS-validated.
    expect(lookupMock).toHaveBeenCalledWith("pub.example", expect.anything());
    expect(lookupMock).toHaveBeenCalledWith("final.example", expect.anything());
    expect(items[0].imageUrl).toBe("https://cdn.example/final.jpg");
  });

  it("blocks a redirect that points at a private address", async () => {
    dnsMap["evil-internal.example"] = "169.254.169.254"; // cloud metadata
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/redir"));
    fetchMock.mockResolvedValueOnce(
      makeResponse(null, { status: 302, location: "https://evil-internal.example/" }),
    );

    const items = await fetchCategoryItems("sports", 8);

    // First hop fetched; the redirect target is rejected before a second fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(items[0].imageUrl).toBeUndefined();
  });

  it("respects the ~256KB body cap and cancels the reader on oversized pages", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunkSize = 65536; // 64KB
    const totalChunks = 50; // ~3.2MB of body if fully read
    const cappedStream = new ReadableStream({
      pull(controller) {
        if (pulled >= totalChunks) {
          controller.close();
          return;
        }
        pulled++;
        // No </head> ever, so only the byte cap can stop the loop.
        controller.enqueue(new TextEncoder().encode("x".repeat(chunkSize)));
      },
      cancel() {
        cancelled = true;
      },
    });

    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/huge"));
    fetchMock.mockResolvedValue(makeResponse(cappedStream));

    const items = await fetchCategoryItems("sports", 8);

    // Loop stops near 256KB (~4 chunks), nowhere near reading all 50 chunks.
    expect(pulled).toBeLessThan(10);
    expect(cancelled).toBe(true);
    expect(items[0].imageUrl).toBeUndefined();
  });

  it("aborts the fetch after the timeout and keeps the item text-only", async () => {
    vi.useFakeTimers();
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/slow"));
    fetchMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const promise = fetchCategoryItems("sports", 8);
    await vi.advanceTimersByTimeAsync(7000);
    const items = await promise;

    expect(items[0].imageUrl).toBeUndefined();
  });

  it("does not throw or hang on malformed HTML", async () => {
    parseUrlMock.mockResolvedValue(feedWithLink("https://pub.example/broken"));
    fetchMock.mockResolvedValue(
      htmlResponse(`<html><head><meta property="og:image" content=  <<>> garbage \x00\xff`),
    );

    const items = await fetchCategoryItems("sports", 8);
    expect(items).toHaveLength(1);
    expect(items[0].imageUrl).toBeUndefined();
  });
});
