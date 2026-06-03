import { describe, it, expect, vi } from "vitest";
import { runJob, type JobDeps } from "./job";

// These tests cover the exit-code contract of the maintenance job without
// touching the database or any external service: `runJob` returns the code that
// the entrypoint hands to `process.exit`.

function makeDeps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    processScheduledArticles: vi.fn(async () => {}),
    runNewsCycle: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runJob exit-code contract", () => {
  it("returns 0 and runs both steps with throwOnError when everything succeeds", async () => {
    const deps = makeDeps();
    const code = await runJob(deps);

    expect(code).toBe(0);
    expect(deps.processScheduledArticles).toHaveBeenCalledOnce();
    expect(deps.processScheduledArticles).toHaveBeenCalledWith({ throwOnError: true });
    expect(deps.runNewsCycle).toHaveBeenCalledOnce();
    expect(deps.runNewsCycle).toHaveBeenCalledWith({ throwOnError: true });
  });

  it("returns 1 when processScheduledArticles fails", async () => {
    const runNewsCycle = vi.fn(async () => {});
    const deps = makeDeps({
      processScheduledArticles: vi.fn(async () => {
        throw new Error("scheduled-article processing blew up");
      }),
      runNewsCycle,
    });

    const code = await runJob(deps);

    expect(code).toBe(1);
    // We must not proceed to the news cycle once an earlier step has failed.
    expect(runNewsCycle).not.toHaveBeenCalled();
  });

  it("returns 1 when runNewsCycle fails", async () => {
    const deps = makeDeps({
      runNewsCycle: vi.fn(async () => {
        throw new Error("news cycle blew up");
      }),
    });

    const code = await runJob(deps);

    expect(code).toBe(1);
    expect(deps.processScheduledArticles).toHaveBeenCalledOnce();
  });
});
