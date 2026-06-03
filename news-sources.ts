import Parser from "rss-parser";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "GPNewsBot/1.0 (+https://gpnews.live)" },
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      ["content:encoded", "contentEncoded"],
    ],
  },
});

const IMG_RE = /\.(jpg|jpeg|png|webp|gif)(\?|$)/i;

// True for any IP we must never let the server connect to: loopback, private
// (RFC1918), link-local, CGNAT, unique-local v6, multicast/reserved, and
// IPv4-mapped v6. Anything that isn't a clearly public, parseable address is
// treated as unsafe (fail closed).
function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase();
    if (ip6 === "::1" || ip6 === "::") return true;
    if (ip6.startsWith("fe80")) return true; // link-local
    if (ip6.startsWith("fc") || ip6.startsWith("fd")) return true; // unique-local fc00::/7
    const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip6);
    if (m) return ipIsPrivate(m[1]);
    return false;
  }
  return true; // not a valid IP literal -> unsafe
}

// Validate a URL is safe to fetch server-side: http(s) only, no embedded creds,
// and every DNS answer for its host must be a public address. Returns the parsed
// URL when safe, else null. Resolving + checking the IPs is what closes the SSRF
// hole (a hostname that points at an internal/cloud-metadata IP is rejected).
async function assertPublicHttpUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  try {
    const addrs = await lookup(u.hostname, { all: true });
    if (addrs.length === 0) return null;
    for (const a of addrs) if (ipIsPrivate(a.address)) return null;
  } catch {
    return null;
  }
  return u;
}

// Fetch the article page once (bounded) and pull a matching photo from its Open
// Graph + Twitter Card meta tags. Only called when the RSS entry itself carried
// no image, so the extra request count stays capped by the per-category item
// limit. Hard-bounded by an abort timeout and a body-size cap to protect against
// slow or oversized responses (DoS / quota concerns from the threat model).
// SSRF defense: redirects are followed manually and EVERY hop is re-validated
// with assertPublicHttpUrl, so a feed link can't redirect into an internal host.
async function fetchOgMedia(link: string): Promise<{ image?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    let current = link;
    let resp: Response | undefined;
    for (let hop = 0; hop < 5; hop++) {
      const safe = await assertPublicHttpUrl(current);
      if (!safe) return {};
      const r = await fetch(safe.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "GPNewsBot/1.0 (+https://gpnews.live)" },
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) return {};
        try {
          current = new URL(loc, safe).toString();
        } catch {
          return {};
        }
        continue;
      }
      resp = r;
      break;
    }
    if (!resp || !resp.ok || !resp.body) return {};
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return {};
    // Read at most ~256KB — og tags live in <head>, so we never need the full page.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < 262144) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});

    const meta = (prop: string): string | undefined => {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
        "i",
      );
      const m = re.exec(html) ?? new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
        "i",
      ).exec(html);
      return m?.[1];
    };

    const image = meta("og:image") ?? meta("og:image:url") ?? meta("twitter:image") ?? meta("twitter:image:src");
    const cleanImg = image && /^https?:\/\//i.test(image) ? image : undefined;
    return { image: cleanImg };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function extractImage(entry: any): string | undefined {
  const enc = entry.enclosure;
  if (enc?.url && (IMG_RE.test(enc.url) || String(enc.type ?? "").startsWith("image/"))) {
    return enc.url;
  }
  const mc = entry.mediaContent;
  if (Array.isArray(mc)) {
    for (const m of mc) {
      const u = m?.$?.url;
      if (u && (IMG_RE.test(u) || String(m?.$?.medium ?? "").includes("image"))) return u;
    }
  } else if (mc?.$?.url) {
    return mc.$.url;
  }
  if (entry.mediaThumbnail?.$?.url) return entry.mediaThumbnail.$.url;
  const html: string = entry.contentEncoded ?? entry.content ?? "";
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (m) return m[1];
  return undefined;
}

export type NewsCategory =
  | "kuwait"
  | "gulf"
  | "sports"
  | "international"
  | "health"
  | "war"
  | "kerala";

export const CATEGORY_LABELS: Record<NewsCategory, { en: string; ml: string }> = {
  kuwait: { en: "Kuwait", ml: "കുവൈറ്റ്" },
  gulf: { en: "Gulf", ml: "ഗൾഫ്" },
  sports: { en: "Sports", ml: "സ്പോർട്സ്" },
  international: { en: "International", ml: "അന്താരാഷ്ട്ര" },
  health: { en: "Health", ml: "ആരോഗ്യം" },
  war: { en: "War Updates", ml: "യുദ്ധ വാർത്തകൾ" },
  kerala: { en: "Kerala News", ml: "കേരള വാർത്ത" },
};

// Real, free, public Google News RSS feeds (no API key required).
const FEEDS: Record<NewsCategory, string[]> = {
  // Kuwait & Gulf are GPNEWS's priority. These queries lean on the trusted Gulf
  // outlets the channel relies on (KUNA, Kuwait TV, Kuwait Times, Arab Times,
  // Gulf News, Khaleej Times). The AI review layer then drops anything against
  // government authorities or otherwise sensitive (see ai-news-service.ts).
  kuwait: [
    "https://news.google.com/rss/search?q=Kuwait%20when:2d&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/search?q=Kuwait%20(KUNA%20OR%20%22Kuwait%20Times%22%20OR%20%22Arab%20Times%22%20OR%20%22Gulf%20News%22)%20when:3d&hl=en-IN&gl=IN&ceid=IN:en",
  ],
  gulf: [
    "https://news.google.com/rss/search?q=(Kuwait%20OR%20Qatar%20OR%20UAE%20OR%20%22Saudi%20Arabia%22%20OR%20Bahrain%20OR%20Oman)%20Gulf%20when:2d&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/search?q=%22Gulf%20News%22%20OR%20%22Gulf%20Today%22%20OR%20%22Khaleej%20Times%22%20when:2d&hl=en-IN&gl=IN&ceid=IN:en",
  ],
  sports: [
    "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-IN&gl=IN&ceid=IN:en",
  ],
  international: [
    "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-IN&gl=IN&ceid=IN:en",
  ],
  health: [
    "https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-IN&gl=IN&ceid=IN:en",
  ],
  war: [
    "https://news.google.com/rss/search?q=war%20OR%20conflict%20OR%20military&hl=en-IN&gl=IN&ceid=IN:en",
  ],
  // Kerala / Malayalam local news. ShareChat has no public feed, so we maximize
  // Malayalam local coverage via Malayalam-language (hl=ml) Google News
  // aggregation across the trusted Malayalam outlets (Manorama, Mathrubhumi,
  // Asianet, Kerala Kaumudi, Madhyamam) plus a Malayalam-term search. "Main news"
  // still comes from the major-outlet queries above.
  kerala: [
    "https://news.google.com/rss/search?q=Kerala%20when:2d&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/search?q=Kerala&hl=ml&gl=IN&ceid=IN:ml",
    "https://news.google.com/rss/search?q=%E0%B4%95%E0%B5%87%E0%B4%B0%E0%B4%B3%E0%B4%82%20when:2d&hl=ml&gl=IN&ceid=IN:ml",
    "https://news.google.com/rss/search?q=(Manorama%20OR%20Mathrubhumi%20OR%20Asianet%20OR%20%22Kerala%20Kaumudi%22%20OR%20Madhyamam)%20when:2d&hl=ml&gl=IN&ceid=IN:ml",
  ],
};

export interface RawNewsItem {
  category: NewsCategory;
  title: string;
  snippet: string;
  link: string;
  source: string;
  publishedAt: Date;
  imageUrl?: string;
}

function cleanText(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchCategoryItems(
  category: NewsCategory,
  limit = 8,
): Promise<RawNewsItem[]> {
  const items: RawNewsItem[] = [];
  for (const url of FEEDS[category]) {
    try {
      const feed = await parser.parseURL(url);
      for (const entry of feed.items ?? []) {
        if (!entry.title || !entry.link) continue;
        // Bound every untrusted feed field. This caps memory, token cost, and
        // the prompt-injection / stored-content surface regardless of how the
        // value is later used (model prompt, DB, public rendering).
        items.push({
          category,
          title: cleanText(entry.title).slice(0, 500),
          snippet: cleanText(entry.contentSnippet ?? entry.content ?? entry.title).slice(0, 2000),
          link: entry.link,
          source: cleanText((entry as any).source?.title ?? feed.title ?? "News").slice(0, 200),
          publishedAt: entry.isoDate ? new Date(entry.isoDate) : new Date(),
          imageUrl: extractImage(entry),
        });
      }
    } catch {
      // Skip a failing feed; other categories/feeds still run.
    }
  }
  const picked = items.slice(0, limit);

  // Best-effort: for items the RSS feed gave no image, visit the article once and
  // pull a matching og:image so the published card shows the photo that belongs
  // to that exact story. If nothing is found the item simply stays text-only.
  // Bounded by the per-category limit and each fetch's own timeout; failures
  // never block publishing.
  const needMedia = picked.filter((it) => !it.imageUrl);
  await Promise.all(
    needMedia.map(async (it) => {
      const media = await fetchOgMedia(it.link);
      if (media.image) it.imageUrl = media.image;
    }),
  );

  return picked;
}
