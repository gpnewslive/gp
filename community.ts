import { Router } from "express";
import { db, gpMembersTable, gpMemberSessionsTable, gpRoomsTable } from "@workspace/db";
import { eq, and, gt, desc, lt } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sendRegistrationEmail } from "../lib/email.js";
import { backupTextToDrive } from "../lib/drive-backup.js";
import { checkBruteForce, recordLoginFailure, clearLoginFailures } from "./system.js";
import { requireAdmin } from "./admin.js";

const router = Router();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function clientIp(req: any): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

// A throwaway hash compared against when an email is not found, so login spends
// the same scrypt time whether or not the account exists. This removes the
// timing side-channel that would otherwise reveal which emails are registered.
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString("hex"));

function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(pw, salt, 64);
  const original = Buffer.from(hash, "hex");
  if (candidate.length !== original.length) return false;
  return timingSafeEqual(candidate, original);
}

function token(): string {
  return randomBytes(32).toString("hex");
}

function extractToken(req: any): string | undefined {
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const x = req.headers["x-member-token"] as string | undefined;
  return x ?? undefined;
}

async function getMember(req: any) {
  const t = extractToken(req);
  if (!t) return null;
  const sessions = await db
    .select()
    .from(gpMemberSessionsTable)
    .where(and(eq(gpMemberSessionsTable.token, t), gt(gpMemberSessionsTable.expiresAt, new Date())))
    .limit(1);
  if (sessions.length === 0) return null;
  const members = await db
    .select()
    .from(gpMembersTable)
    .where(eq(gpMembersTable.id, Number(sessions[0].memberId)))
    .limit(1);
  return members[0] ?? null;
}

async function requireMember(req: any, res: any, next: any) {
  try {
    const member = await getMember(req);
    if (!member) return res.status(401).json({ error: "Please log in as a member" });
    req.member = member;
    next();
  } catch (err) {
    req.log?.error(err, "Member auth failed");
    return res.status(500).json({ error: "Auth error" });
  }
}

function publicMember(m: any) {
  return { id: m.id, name: m.name, email: m.email, country: m.country, location: m.location };
}

// Register
router.post("/community/register", async (req: any, res: any) => {
  try {
    // Per-IP throttle: caps how many accounts/email probes a single client can
    // make, blunting both account-enumeration and bulk account creation. Keyed
    // separately from login so the two flows don't share a counter.
    const rlKey = `community-register:${clientIp(req)}`;
    const rl = checkBruteForce(rlKey);
    if (!rl.allowed) {
      return res.status(429).json({ error: `Too many attempts. Try again in ${rl.retryAfter}s.` });
    }
    recordLoginFailure(rlKey);

    const { name, email, password, phone, country, location } = req.body ?? {};
    if (!name || !email || !password || String(password).length < 6) {
      return res.status(400).json({ error: "Name, email and a password (min 6 chars) are required" });
    }
    const normEmail = String(email).trim().toLowerCase();
    const existing = await db.select().from(gpMembersTable).where(eq(gpMembersTable.email, normEmail)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "This email is already registered. Please log in." });
    }
    const rows = await db
      .insert(gpMembersTable)
      .values({
        name: String(name).trim(),
        email: normEmail,
        phone: phone ? String(phone) : null,
        country: country ? String(country) : null,
        location: location ? String(location) : null,
        passwordHash: hashPassword(String(password)),
      })
      .returning();
    const member = rows[0];

    const t = token();
    await db.insert(gpMemberSessionsTable).values({
      token: t,
      memberId: String(member.id),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    // Backups (non-fatal): email + Google Drive
    sendRegistrationEmail(member).catch(() => {});
    backupTextToDrive(
      `gpnews-member-${member.id}-${Date.now()}.txt`,
      `New member\nName: ${member.name}\nEmail: ${member.email}\nPhone: ${member.phone ?? "-"}\nCountry: ${member.country ?? "-"}\nLocation: ${member.location ?? "-"}\nTime: ${new Date().toISOString()}`,
    ).catch(() => {});

    return res.json({ success: true, token: t, member: publicMember(member) });
  } catch (err: any) {
    req.log?.error(err, "Registration failed");
    return res.status(500).json({ error: "Registration failed" });
  }
});

// Login
router.post("/community/login", async (req: any, res: any) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const normEmail = String(email).trim().toLowerCase();

    // Throttle online password guessing per (IP, targeted account). Keying by the
    // targeted email — not just the IP — is deliberate and load-bearing:
    //  - A successful login to ONE account can never reset the failure counter for
    //    a DIFFERENT victim account from the same IP. A bare per-IP key that is
    //    cleared on success lets an attacker who owns any account reset their own
    //    throttle at will and guess a victim's password indefinitely.
    //  - It also avoids the shared-proxy-IP problem: behind the platform proxy
    //    every member appears to share one IP, so a single global per-IP counter
    //    would let a handful of failures lock out all members at once.
    const rlKey = `community-login:${clientIp(req)}:${normEmail}`;
    const rl = checkBruteForce(rlKey);
    if (!rl.allowed) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${rl.retryAfter}s.` });
    }

    const rows = await db.select().from(gpMembersTable).where(eq(gpMembersTable.email, normEmail)).limit(1);
    const member = rows[0];
    // Always run a constant-time verify (against a dummy hash when the account
    // is missing) so response timing never reveals whether the email exists.
    const ok = verifyPassword(String(password), member?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!member || !ok) {
      recordLoginFailure(rlKey);
      return res.status(401).json({ error: "Invalid email or password" });
    }
    clearLoginFailures(rlKey);
    const t = token();
    await db.insert(gpMemberSessionsTable).values({
      token: t,
      memberId: String(member.id),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    db.delete(gpMemberSessionsTable).where(lt(gpMemberSessionsTable.expiresAt, new Date())).catch(() => {});
    return res.json({ success: true, token: t, member: publicMember(member) });
  } catch (err: any) {
    req.log?.error(err, "Login failed");
    return res.status(500).json({ error: "Login failed" });
  }
});

router.get("/community/me", async (req: any, res: any) => {
  const member = await getMember(req);
  if (!member) return res.status(401).json({ error: "Not authenticated" });
  return res.json({ member: publicMember(member) });
});

router.post("/community/logout", async (req: any, res: any) => {
  const t = extractToken(req);
  if (t) {
    try {
      await db.delete(gpMemberSessionsTable).where(eq(gpMemberSessionsTable.token, t));
    } catch (err) {
      req.log?.error(err, "Member logout failed");
      return res.status(500).json({ error: "Logout failed" });
    }
  }
  return res.json({ success: true });
});

// Public: list active rooms (visible to everyone, joinable by members only).
// Explicitly select a scrubbed public view: the Jitsi join secret (roomKey) and
// the internal creator id (createdById) MUST NOT be exposed here, or any
// unauthenticated client could join members-only calls directly via meet.jit.si.
// createdByName is the creator's self-chosen display name, shown intentionally.
router.get("/community/rooms", async (req: any, res: any) => {
  try {
    const rows = await db
      .select({
        id: gpRoomsTable.id,
        name: gpRoomsTable.name,
        description: gpRoomsTable.description,
        topic: gpRoomsTable.topic,
        createdByName: gpRoomsTable.createdByName,
        createdAt: gpRoomsTable.createdAt,
      })
      .from(gpRoomsTable)
      .where(eq(gpRoomsTable.isActive, true))
      .orderBy(desc(gpRoomsTable.createdAt))
      .limit(100);
    return res.json({ rooms: rows });
  } catch (err: any) {
    req.log?.error(err, "List rooms failed");
    return res.status(500).json({ error: "Failed to load rooms" });
  }
});

// Member: create a room
router.post("/community/rooms", requireMember, async (req: any, res: any) => {
  try {
    const { name, description, topic } = req.body ?? {};
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: "Room name is required" });
    }
    const roomKey = "gpnews-" + randomBytes(8).toString("hex");
    const rows = await db
      .insert(gpRoomsTable)
      .values({
        name: String(name).trim(),
        description: description ? String(description) : null,
        topic: topic ? String(topic) : null,
        roomKey,
        createdById: String(req.member.id),
        createdByName: req.member.name,
      })
      .returning();
    return res.json({ success: true, room: rows[0] });
  } catch (err: any) {
    req.log?.error(err, "Create room failed");
    return res.status(500).json({ error: "Failed to create room" });
  }
});

// Member: get join details (Jitsi room key) for a room
router.post("/community/rooms/:id/join", requireMember, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    const rows = await db.select().from(gpRoomsTable).where(eq(gpRoomsTable.id, id)).limit(1);
    const room = rows[0];
    if (!room || !room.isActive) return res.status(404).json({ error: "Room not available" });
    return res.json({ roomKey: room.roomKey, name: room.name, displayName: req.member.name });
  } catch (err: any) {
    req.log?.error(err, "Join room failed");
    return res.status(500).json({ error: "Failed to join" });
  }
});

// Member: close a room they created
router.post("/community/rooms/:id/close", requireMember, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    const rows = await db.select().from(gpRoomsTable).where(eq(gpRoomsTable.id, id)).limit(1);
    const room = rows[0];
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.createdById !== String(req.member.id)) {
      return res.status(403).json({ error: "Only the room creator can close it" });
    }
    await db.update(gpRoomsTable).set({ isActive: false }).where(eq(gpRoomsTable.id, id));
    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error(err, "Close room failed");
    return res.status(500).json({ error: "Failed to close room" });
  }
});

// ---------------------------------------------------------------------------
// Admin: GP Live Connect control panel (all routes are requireAdmin).
// These let an admin moderate the community: see every room (active or closed),
// force-close / reopen / delete rooms, bulk-purge stale rooms, and manage
// members. The Jitsi join secret (roomKey) is never returned even to admins —
// it isn't needed for moderation and keeping it server-only limits blast radius.
// ---------------------------------------------------------------------------

router.get("/community/admin/rooms", requireAdmin, async (req: any, res: any) => {
  try {
    const rows = await db
      .select({
        id: gpRoomsTable.id,
        name: gpRoomsTable.name,
        description: gpRoomsTable.description,
        topic: gpRoomsTable.topic,
        createdByName: gpRoomsTable.createdByName,
        isActive: gpRoomsTable.isActive,
        createdAt: gpRoomsTable.createdAt,
      })
      .from(gpRoomsTable)
      .orderBy(desc(gpRoomsTable.createdAt))
      .limit(500);
    return res.json({ rooms: rows });
  } catch (err: any) {
    req.log?.error(err, "Admin list rooms failed");
    return res.status(500).json({ error: "Failed to load rooms" });
  }
});

router.post("/community/admin/rooms/:id/close", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid room id" });
    const rows = await db
      .update(gpRoomsTable)
      .set({ isActive: false })
      .where(eq(gpRoomsTable.id, id))
      .returning({ id: gpRoomsTable.id });
    if (rows.length === 0) return res.status(404).json({ error: "Room not found" });
    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error(err, "Admin close room failed");
    return res.status(500).json({ error: "Failed to close room" });
  }
});

router.post("/community/admin/rooms/:id/reopen", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid room id" });
    const rows = await db
      .update(gpRoomsTable)
      .set({ isActive: true })
      .where(eq(gpRoomsTable.id, id))
      .returning({ id: gpRoomsTable.id });
    if (rows.length === 0) return res.status(404).json({ error: "Room not found" });
    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error(err, "Admin reopen room failed");
    return res.status(500).json({ error: "Failed to reopen room" });
  }
});

router.delete("/community/admin/rooms/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid room id" });
    const rows = await db
      .delete(gpRoomsTable)
      .where(eq(gpRoomsTable.id, id))
      .returning({ id: gpRoomsTable.id });
    if (rows.length === 0) return res.status(404).json({ error: "Room not found" });
    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error(err, "Admin delete room failed");
    return res.status(500).json({ error: "Failed to delete room" });
  }
});

// Bulk-delete stale rooms. Body: { days?: number, onlyInactive?: boolean }.
// "Old" = createdAt older than `days` (default 30, clamped 1-365). When
// onlyInactive is true, only already-closed rooms in that window are removed.
router.post("/community/admin/rooms/purge", requireAdmin, async (req: any, res: any) => {
  try {
    const rawDays = Number(req.body?.days);
    const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.floor(rawDays))) : 30;
    const onlyInactive = req.body?.onlyInactive === true;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const cond = onlyInactive
      ? and(lt(gpRoomsTable.createdAt, cutoff), eq(gpRoomsTable.isActive, false))
      : lt(gpRoomsTable.createdAt, cutoff);
    const rows = await db.delete(gpRoomsTable).where(cond).returning({ id: gpRoomsTable.id });
    return res.json({ success: true, deleted: rows.length });
  } catch (err: any) {
    req.log?.error(err, "Admin purge rooms failed");
    return res.status(500).json({ error: "Failed to purge rooms" });
  }
});

router.get("/community/admin/members", requireAdmin, async (req: any, res: any) => {
  try {
    const rows = await db
      .select({
        id: gpMembersTable.id,
        name: gpMembersTable.name,
        email: gpMembersTable.email,
        phone: gpMembersTable.phone,
        country: gpMembersTable.country,
        location: gpMembersTable.location,
        createdAt: gpMembersTable.createdAt,
      })
      .from(gpMembersTable)
      .orderBy(desc(gpMembersTable.createdAt))
      .limit(1000);
    return res.json({ members: rows });
  } catch (err: any) {
    req.log?.error(err, "Admin list members failed");
    return res.status(500).json({ error: "Failed to load members" });
  }
});

// Remove a member and revoke their access: delete the account, drop their
// sessions, and close any rooms they created so no orphaned active room keeps a
// deleted member's name attached.
router.delete("/community/admin/members/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid member id" });
    const rows = await db
      .delete(gpMembersTable)
      .where(eq(gpMembersTable.id, id))
      .returning({ id: gpMembersTable.id });
    if (rows.length === 0) return res.status(404).json({ error: "Member not found" });
    await db.delete(gpMemberSessionsTable).where(eq(gpMemberSessionsTable.memberId, String(id)));
    await db.update(gpRoomsTable).set({ isActive: false }).where(eq(gpRoomsTable.createdById, String(id)));
    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error(err, "Admin delete member failed");
    return res.status(500).json({ error: "Failed to delete member" });
  }
});

export default router;
