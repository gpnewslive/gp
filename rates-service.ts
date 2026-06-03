import { logger } from "./logger.js";

export interface RateItem {
  /** Short display label, e.g. "KWD → INR". */
  label: string;
  /** Numeric value formatted to a sensible precision. */
  value: string;
  /** Base currency code. */
  code: string;
}

export interface RatesPayload {
  updatedAt: string;
  base: string;
  rates: RateItem[];
}

const SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 60 * 60 * 1000; // refresh at most once per hour

let cache: RatesPayload | null = null;
let cachedAt = 0;
let inflight: Promise<RatesPayload | null> | null = null;

function fmt(n: number, digits: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Builds the scrolling-ticker rate list from a USD-based rate table.
 * Gulf currencies are expressed in Indian Rupees (the value of 1 unit), which
 * is what Gulf-Malayalee readers care about for remittance.
 */
function buildRates(usd: Record<string, number>): RateItem[] {
  const inr = usd.INR;
  const items: RateItem[] = [];
  const perInr = (code: string, digits = 2) => {
    const r = usd[code];
    if (!inr || !r) return;
    items.push({ code, label: `${code} → INR`, value: fmt(inr / r, digits) });
  };

  perInr("KWD"); // Kuwaiti Dinar
  perInr("AED"); // UAE Dirham
  perInr("SAR"); // Saudi Riyal
  perInr("QAR"); // Qatari Riyal
  perInr("OMR"); // Omani Rial
  perInr("BHD"); // Bahraini Dinar

  if (inr) items.push({ code: "USD", label: "USD → INR", value: fmt(inr, 2) });
  if (usd.KWD) items.push({ code: "USD", label: "USD → KWD", value: fmt(usd.KWD, 3) });

  return items;
}

async function fetchRates(): Promise<RatesPayload | null> {
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`rates source returned ${res.status}`);
    const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (data.result !== "success" || !data.rates) throw new Error("rates source payload invalid");
    const payload: RatesPayload = {
      updatedAt: new Date().toISOString(),
      base: "live",
      rates: buildRates(data.rates),
    };
    cache = payload;
    cachedAt = Date.now();
    logger.info({ count: payload.rates.length }, "Currency rates refreshed");
    return payload;
  } catch (err) {
    logger.error({ err }, "Failed to fetch currency rates");
    return cache; // serve stale on failure
  }
}

/** Returns cached rates, refreshing in the background when older than the TTL. */
export async function getRates(): Promise<RatesPayload | null> {
  const fresh = cache && Date.now() - cachedAt < TTL_MS;
  if (fresh) return cache;
  if (!inflight) {
    inflight = fetchRates().finally(() => {
      inflight = null;
    });
  }
  // If we have stale cache, return it immediately while refreshing.
  if (cache) return cache;
  return inflight;
}

/** Force a refresh (used by the scheduler). */
export async function refreshRates(): Promise<void> {
  await fetchRates();
}
