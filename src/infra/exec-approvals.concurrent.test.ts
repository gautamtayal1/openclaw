import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./exec-approvals-test-helpers.js";

const TEMP_FILES: string[] = [];

async function waitForFile(filePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForExit(child: ReturnType<typeof spawn>) {
  return await new Promise<void>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `child exited with ${String(code)}\nstdout:\n${Buffer.concat(stdout).toString("utf8")}\nstderr:\n${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

afterEach(() => {
  for (const filePath of TEMP_FILES.splice(0)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("exec approvals concurrent writers", () => {
  it("preserves both allow-always entries across separate processes", async () => {
    const home = makeTempDir();
    const workerPath = path.join(makeTempDir(), "exec-approvals-worker.ts");
    const startPath = path.join(makeTempDir(), "start");
    const readyOne = `${startPath}.one.ready`;
    const readyTwo = `${startPath}.two.ready`;
    TEMP_FILES.push(workerPath, startPath, readyOne, readyTwo);
    fs.writeFileSync(
      workerPath,
      `
import fs from "node:fs";
import { addAllowlistEntry, loadExecApprovals } from ${JSON.stringify(path.resolve(process.cwd(), "src/infra/exec-approvals.ts"))};

const [pattern, readyPath, startPath] = process.argv.slice(2);
const approvals = loadExecApprovals();
fs.writeFileSync(readyPath, "ready\\n");
while (!fs.existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
addAllowlistEntry(approvals, "main", pattern);
`,
      "utf8",
    );

    const baseEnv = { ...process.env, OPENCLAW_HOME: home };
    const childOne = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, "/bin/pwd", readyOne, startPath],
      {
        cwd: process.cwd(),
        env: baseEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const childTwo = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, "/usr/bin/uname", readyTwo, startPath],
      {
        cwd: process.cwd(),
        env: baseEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await Promise.all([waitForFile(readyOne, 5_000), waitForFile(readyTwo, 5_000)]);
    fs.writeFileSync(startPath, "go\n", "utf8");
    await Promise.all([waitForExit(childOne), waitForExit(childTwo)]);

    const filePath = path.join(home, ".openclaw", "exec-approvals.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      agents?: { main?: { allowlist?: Array<{ pattern: string }> } };
    };
    const patterns = new Set(saved.agents?.main?.allowlist?.map((entry) => entry.pattern) ?? []);
    expect(patterns).toEqual(new Set(["/bin/pwd", "/usr/bin/uname"]));
  });
});
