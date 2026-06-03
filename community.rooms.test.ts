import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db, gpRoomsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";

// Locks in the room-privacy boundary (Task: Community Authentication and Room
// Privacy): the public room list MUST be a scrubbed projection. The Jitsi join
// secret (roomKey) is bearer-style — leaking it lets unauthenticated clients
// join members-only calls directly via meet.jit.si. The internal creator id
// (createdById) must also stay server-side.

let server: Server;
let baseUrl: string;
let roomId: number;
const SECRET_ROOM_KEY = `gpnews-test-secret-${Date.now()}`;
const ROOM_NAME = `__test_room_${Date.now()}`;

beforeAll(async () => {
  const rows = await db
    .insert(gpRoomsTable)
    .values({
      name: ROOM_NAME,
      description: "test",
      topic: "test",
      roomKey: SECRET_ROOM_KEY,
      createdById: "999999",
      createdByName: "Tester",
      isActive: true,
    })
    .returning({ id: gpRoomsTable.id });
  roomId = rows[0].id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (roomId) await db.delete(gpRoomsTable).where(eq(gpRoomsTable.id, roomId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("GET /api/community/rooms (public listing)", () => {
  it("returns the room but never exposes the join secret or creator id", async () => {
    const res = await fetch(`${baseUrl}/api/community/rooms`);
    expect(res.status).toBe(200);

    const raw = await res.text();
    // The raw secret must not appear anywhere in the public payload.
    expect(raw).not.toContain(SECRET_ROOM_KEY);

    const json = JSON.parse(raw) as { rooms: Array<Record<string, unknown>> };
    expect(Array.isArray(json.rooms)).toBe(true);

    const ours = json.rooms.find((r) => r.name === ROOM_NAME);
    expect(ours, "inserted room should be listed").toBeTruthy();

    // No room object in the listing may carry the secret or internal fields.
    for (const room of json.rooms) {
      expect(room).not.toHaveProperty("roomKey");
      expect(room).not.toHaveProperty("createdById");
    }
    // The intended public shape is present.
    expect(ours).toHaveProperty("id");
    expect(ours).toHaveProperty("createdByName");
  });
});
