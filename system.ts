import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { v2 as cloudinary } from "cloudinary";
import { requireAdmin } from "./admin.js";

const router = Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const loginAttempts = new Map<string, { count: number; firstAt: number; blocked: boolean }>();

export function checkBruteForce(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 10;
  const BLOCK_DURATION = 15 * 60 * 1000;

  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };

  if (entry.blocked) {
    const elapsed = now - entry.firstAt;
    if (elapsed < BLOCK_DURATION) {
      return { allowed: false, retryAfter: Math.ceil((BLOCK_DURATION - elapsed) / 1000) };
    }
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  if (now - entry.firstAt > WINDOW) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  return { allowed: entry.count < MAX_ATTEMPTS };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, firstAt: now, blocked: false });
  } else {
    entry.count++;
    if (entry.count >= 10) entry.blocked = true;
    loginAttempts.set(ip, entry);
  }
}

export function clearLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
}

async function checkDatabase(): Promise<{ status: string; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: "error", error: err.message };
  }
}

async function checkCloudinary(): Promise<{ status: string; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    await cloudinary.api.ping();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: "error", error: err.message };
  }
}

async function checkApi(): Promise<{ status: string; latencyMs: number }> {
  const start = Date.now();
  return { status: "ok", latencyMs: Date.now() - start };
}

router.get("/system/health", requireAdmin, async (req: any, res: any) => {
  const [dbResult, cloudinaryResult, apiResult] = await Promise.allSettled([
    checkDatabase(),
    checkCloudinary(),
    checkApi(),
  ]);

  const db_ = dbResult.status === "fulfilled" ? dbResult.value : { status: "error", error: "Check failed" };
  const cdn = cloudinaryResult.status === "fulfilled" ? cloudinaryResult.value : { status: "error", error: "Check failed" };
  const api = apiResult.status === "fulfilled" ? apiResult.value : { status: "ok", latencyMs: 0 };

  const allOk = db_.status === "ok" && cdn.status === "ok";

  return res.status(allOk ? 200 : 207).json({
    overall: allOk ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks: {
      api,
      database: db_,
      cloudinary: cdn,
      security: {
        status: "ok",
        blockedIps: [...loginAttempts.entries()]
          .filter(([, v]) => v.blocked)
          .map(([ip]) => ip).length,
      },
    },
  });
});

router.get("/system/health/public", async (_req, res) => {
  return res.json({ status: "ok", ts: new Date().toISOString() });
});

export default router;
