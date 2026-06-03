import { describe, it, expect, afterEach, vi } from "vitest";
import { checkBruteForce, recordLoginFailure, clearLoginFailures } from "./system.js";

// Locks in the abuse-control primitive that backs the community login/register
// throttling (Task: Community Authentication and Room Privacy) as well as admin
// login. The counter is per-key and in-memory; tests use unique keys so the
// shared module-level Map can't leak state between cases.

afterEach(() => {
  vi.useRealTimers();
});

describe("checkBruteForce / recordLoginFailure", () => {
  it("allows attempts until the threshold, then blocks with a retryAfter", () => {
    const key = "test:threshold";
    expect(checkBruteForce(key).allowed).toBe(true);

    // 9 failures stay under the cap of 10.
    for (let i = 0; i < 9; i++) recordLoginFailure(key);
    expect(checkBruteForce(key).allowed).toBe(true);

    // The 10th failure trips the block.
    recordLoginFailure(key);
    const res = checkBruteForce(key);
    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBeGreaterThan(0);

    clearLoginFailures(key);
  });

  it("keys are namespaced so login/register and different IPs don't share a counter", () => {
    const login = "community-login:203.0.113.7";
    const register = "community-register:203.0.113.7";
    const otherIp = "community-login:198.51.100.9";

    for (let i = 0; i < 10; i++) recordLoginFailure(login);

    expect(checkBruteForce(login).allowed).toBe(false);
    // Same IP on the register flow is unaffected.
    expect(checkBruteForce(register).allowed).toBe(true);
    // A different IP on the same flow is unaffected.
    expect(checkBruteForce(otherIp).allowed).toBe(true);

    clearLoginFailures(login);
    clearLoginFailures(register);
    clearLoginFailures(otherIp);
  });

  it("clearLoginFailures resets a blocked counter (used on successful login)", () => {
    const key = "test:reset";
    for (let i = 0; i < 10; i++) recordLoginFailure(key);
    expect(checkBruteForce(key).allowed).toBe(false);

    clearLoginFailures(key);
    expect(checkBruteForce(key).allowed).toBe(true);
  });

  it("the block lifts after the block window elapses", () => {
    vi.useFakeTimers();
    const key = "test:block-expiry";
    for (let i = 0; i < 10; i++) recordLoginFailure(key);
    expect(checkBruteForce(key).allowed).toBe(false);

    // Just past the 15-minute block duration.
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(checkBruteForce(key).allowed).toBe(true);
  });

  it("the failure counter resets after the rolling window with no block", () => {
    vi.useFakeTimers();
    const key = "test:window-reset";
    for (let i = 0; i < 5; i++) recordLoginFailure(key);
    expect(checkBruteForce(key).allowed).toBe(true);

    // After the 15-minute window the stale entry is dropped.
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(checkBruteForce(key).allowed).toBe(true);

    // And a fresh failure starts a clean count.
    recordLoginFailure(key);
    expect(checkBruteForce(key).allowed).toBe(true);
    clearLoginFailures(key);
  });
});
