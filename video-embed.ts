// Shared server-side validation for admin-supplied video URLs that end up as
// iframe `src` on the PUBLIC site (homepage video blocks and editorial article
// videos). Treating these URLs as trusted content is a stored-XSS sink: a value
// like `javascript:...` rendered into an <iframe src> executes script in the
// site origin and can steal the bearer tokens kept in browser storage.
//
// Both the homepage layout sanitizer (routes/site.ts) and the article write
// paths (routes/articles.ts) MUST run admin-supplied video URLs through
// sanitizeVideoUrl() before persisting, so the stored value is never
// attacker-controlled.

// Hosts accepted as input for a video block. This includes watch-page hosts
// (youtu.be, vimeo.com, m.youtube.com) that sanitizeVideoUrl() normalizes into
// canonical embed URLs. The normalized OUTPUT origins (www.youtube.com,
// player.vimeo.com, meet.jit.si) are the only origins ever rendered. Any other
// host or scheme is rejected.
export const ALLOWED_VIDEO_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
  "meet.jit.si",
]);

/**
 * Validate and normalize an admin-supplied video URL into a safe, embeddable
 * https URL. Rejects dangerous schemes (e.g. javascript:) and any host that is
 * not on the allowlist by returning "" (no iframe is rendered). Returning a
 * canonical embed URL also means the stored value is never attacker-controlled.
 */
export function sanitizeVideoUrl(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") return "";
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_VIDEO_HOSTS.has(host)) return "";

  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\/+/, "").split("/")[0];
    return /^[\w-]+$/.test(id) ? `https://www.youtube.com/embed/${id}` : "";
  }
  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    const v = u.searchParams.get("v");
    if (v && /^[\w-]+$/.test(v)) return `https://www.youtube.com/embed/${v}`;
    if (u.pathname.startsWith("/embed/")) {
      const id = u.pathname.slice("/embed/".length).split("/")[0];
      return /^[\w-]+$/.test(id) ? `https://www.youtube.com/embed/${id}` : "";
    }
    return "";
  }
  if (host === "player.vimeo.com") {
    const id = u.pathname.replace(/^\/+/, "").replace(/^video\//, "").split("/")[0];
    return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : "";
  }
  if (host === "vimeo.com" || host === "www.vimeo.com") {
    const id = u.pathname.replace(/^\/+/, "").split("/")[0];
    return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : "";
  }
  if (host === "meet.jit.si") {
    const room = u.pathname.replace(/^\/+/, "").split("/")[0];
    return /^[\w.-]+$/.test(room) ? `https://meet.jit.si/${room}` : "";
  }
  return "";
}
