import OpenAI from "openai";

let _client: OpenAI | null = null;

// Prefer the Replit-managed AI Integrations proxy (no separate OpenAI billing
// required). Fall back to a direct OPENAI_API_KEY if the proxy is not set up.
function resolveCredentials(): { apiKey: string; baseURL?: string } | null {
  const proxyKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const proxyUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (proxyKey && proxyUrl) {
    return { apiKey: proxyKey, baseURL: proxyUrl };
  }
  if (process.env.OPENAI_API_KEY) {
    return { apiKey: process.env.OPENAI_API_KEY };
  }
  return null;
}

export function isOpenAiConfigured(): boolean {
  return resolveCredentials() !== null;
}

export function getOpenAi(): OpenAI {
  const creds = resolveCredentials();
  if (!creds) {
    throw new Error(
      "AI is not configured. Set up the Replit OpenAI integration or provide OPENAI_API_KEY.",
    );
  }
  if (!_client) {
    _client = new OpenAI({ apiKey: creds.apiKey, baseURL: creds.baseURL });
  }
  return _client;
}

// Malayalam translation quality is the site's core credibility, so default to
// the full gpt-4o model (notably stronger Malayalam grammar/vocabulary than
// gpt-4o-mini). Still billed via the Replit OpenAI proxy. Override with
// AI_NEWS_MODEL if a cheaper/different model is ever needed.
export const AI_NEWS_MODEL = process.env.AI_NEWS_MODEL ?? "gpt-4o";
