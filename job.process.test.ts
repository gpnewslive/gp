import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const jobEntry = path.join(here, "job.ts");
const tsxBin = path.join(here, "..", "node_modules", ".bin", "tsx");

function runEntry(env: NodeJS.ProcessEnv): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [jobEntry], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code }));
  });
}

// End-to-end check of the real entrypoint (bootstrap + process.exit wiring): when
// the maintenance work fails, the process must exit non-zero so a Scheduled
// Deployment surfaces an alert instead of silently doing nothing. We force a
// failure by pointing the job at an unreachable database, which makes the very
// first DB update in processScheduledArticles throw.
describe("scheduled maintenance job process", () => {
  it("exits with a non-zero status when the work fails", async () => {
    const { code } = await runEntry({
      DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/nonexistent",
    });
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
  }, 60000);
});
