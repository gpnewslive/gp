import { Router } from "express";
import { AdminLoginBody } from "@workspace/api-zod";
import { db, adminSessionsTable } from "@workspace/db";
import { eq, gt, and, lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { checkBruteForce, recordLoginFailure, clearLoginFailures } from "./system.js";

const router = Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Sessions last 30 days
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function extractToken(req: any): string | undefined {
  const xToken = req.headers["x-admin-token"] as string | undefined;
  if (xToken) return xToken;
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

async function getValidSession(token: string) {
  const rows = await db
    .select()
    .from(adminSessionsTable)
    .where(and(eq(adminSessionsTable.token, token), gt(adminSessionsTable.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

// Returns true when the request carries a valid admin session token. Unlike
// `requireAdmin`, it never sends a response — callers use it to decide whether a
// public endpoint may also expose privileged (e.g. draft) data to a logged-in
// admin, without leaking existence via a 401 to anonymous callers.
export async function isAdminRequest(req: any): Promise<boolean> {
  try {
    const token = extractToken(req);
    if (!token) return false;
    const session = await getValidSession(token);
    return !!session;
  } catch {
    return false;
  }
}

export async function requireAdmin(req: any, res: any, next: any) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const session = await getValidSession(token);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    req.adminUsername = session.username;
    next();
  } catch (err) {
    req.log?.error(err, "Auth check failed");
    return res.status(500).json({ error: "Auth error" });
  }
}

router.post("/admin/login", async (req: any, res: any) => {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  const { allowed, retryAfter } = checkBruteForce(ip);
  if (!allowed) {
    return res.status(429).json({
      success: false,
      message: `Too many failed attempts. Try again in ${retryAfter}s.`,
    });
  }

  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const { username, password } = parsed.data;

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    req.log?.error("ADMIN_USERNAME/ADMIN_PASSWORD not configured; rejecting login");
    return res.status(503).json({ success: false, message: "Admin login not configured" });
  }

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    recordLoginFailure(ip);
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  clearLoginFailures(ip);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(adminSessionsTable).values({ token, username, expiresAt });

  // Best-effort cleanup of expired sessions
  db.delete(adminSessionsTable).where(lt(adminSessionsTable.expiresAt, new Date())).catch(() => {});

  res.setHeader("X-Admin-Token", token);
  return res.json({ success: true, message: token });
});

router.post("/admin/logout", async (req: any, res: any) => {
  const token = extractToken(req);
  if (token) {
    try {
      await db.delete(adminSessionsTable).where(eq(adminSessionsTable.token, token));
    } catch (err) {
      req.log?.error(err, "Logout failed to delete session");
      return res.status(500).json({ success: false, message: "Logout failed, please try again" });
    }
  }
  return res.json({ success: true, message: "Logged out" });
});

router.get("/admin/me", async (req: any, res: any) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const session = await getValidSession(token);
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  return res.json({ username: session.username });
});

export default router;
