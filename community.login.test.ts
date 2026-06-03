import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, scryptSync } from "node:crypto";
import { db, gpMembersTable, gpMemberSessionsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";

// Locks in the login abuse-control fix (Task: Community Authentication and Room
// Privacy). The login throttle is keyed by (IP, targeted email), and a success
// clears ONLY that tuple. This regression test proves an attacker cannot reset a
// victim's guess throttle by logging into a different account from the same IP.

// Mirror the server's password hash format (salt:scrypt64-hex) so we can seed
// members with known passwords without exposing the route's private helper.
function makeHash(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

let server: Server;
let baseUrl: string;
let victimId: number;
let attackerId: number;
const stamp = Date.now();
const victimEmail = `victim_${stamp}@test.local`;
const attackerEmail = `attacker_${stamp}@test.local`;
const ATTACKER_PW = "attacker-correct-pw";

async function login(email: string, password: string) {
  return fetch(`${baseUrl}/api/community/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

beforeAll(async () => {
  const v = await db
    .insert(gpMembersTable)
    .values({ name: "Victim", email: victimEmail, passwordHash: makeHash("victim-correct-pw") })
    .returning({ id: gpMembersTable.id });
  victimId = v[0].id;
  const a = await db
    .insert(gpMembersTable)
    .values({ name: "Attacker", email: attackerEmail, passwordHash: makeHash(ATTACKER_PW) })
    .returning({ id: gpMembersTable.id });
  attackerId = a[0].id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const id of [victimId, attackerId]) {
    if (!id) continue;
    await db.delete(gpMemberSessionsTable).where(eq(gpMemberSessionsTable.memberId, String(id)));
    await db.delete(gpMembersTable).where(eq(gpMembersTable.id, id));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("POST /api/community/login throttling", () => {
  it("blocks guessing after repeated failures, and a success on another account does NOT reset it", async () => {
    // 10 wrong-password attempts against the victim are accepted as 401 (the
    // limiter caps at 10 before blocking).
    for (let i = 0; i < 10; i++) {
      const res = await login(victimEmail, `wrong-${i}`);
      expect(res.status).toBe(401);
    }

    // The 11th victim attempt is now throttled.
    expect((await login(victimEmail, "wrong-again")).status).toBe(429);

    // The attacker can still log into their OWN account (its counter is separate
    // and untouched), which under a per-IP-only scheme would have reset the
    // shared counter.
    expect((await login(attackerEmail, ATTACKER_PW)).status).toBe(200);

    // Crucially, the victim's account is STILL throttled — the unrelated success
    // did not reset it. This is the bypass that the (IP, email) keying closes.
    expect((await login(victimEmail, "wrong-after-bypass")).status).toBe(429);
  });

  it("a correct password on a fresh account is not affected by another account's lockout", async () => {
    // Sanity: the attacker account (never failed) logs in cleanly.
    const res = await login(attackerEmail, ATTACKER_PW);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success?: boolean; token?: string };
    expect(json.success).toBe(true);
    expect(typeof json.token).toBe("string");
  });
});
