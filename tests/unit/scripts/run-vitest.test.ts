import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");
const runner = resolve(root, "scripts", "test", "run-vitest.ts");
const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");

type PlannedCommand = { args: string[]; nodeOptions: string | null };

function readPlan(ci: boolean): PlannedCommand[] {
  const output = execFileSync(process.execPath, [tsx, runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: ci ? "true" : "false",
      GITHUB_ACTIONS: ci ? "true" : "false",
      TEST_RUNNER_DRY_RUN: "1",
    },
  });
  return JSON.parse(output) as PlannedCommand[];
}

describe("local Vitest runner plan", () => {
  it("keeps CI and local discovery plans equivalent while bounding workers", () => {
    const local = readPlan(false);
    const ci = readPlan(true);

    expect(local).toHaveLength(7);
    expect(ci).toHaveLength(7);
    expect(local.map((command) => command.args)).toEqual(
      ci.map((command) => command.args),
    );
    expect(local[0].nodeOptions).toContain("--max-old-space-size=6144");
    expect(ci[0].nodeOptions).toContain("--max-old-space-size=6144");
    expect(local.at(-1)?.args).toContain("--maxWorkers=1");
    expect(ci.at(-1)?.args).toContain("--maxWorkers=1");
    expect(ci.at(-1)?.args).toContain("--exclude");
  });
});
