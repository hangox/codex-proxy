import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type VitestCommand = {
  args: string[];
  env: NodeJS.ProcessEnv;
};

const vitestEntrypoint = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

if (!existsSync(vitestEntrypoint)) {
  throw new Error(`Vitest entrypoint is missing: ${vitestEntrypoint}`);
}

const tokenizerTest = "tests/unit/routes/shared/compact-tokenizer.test.ts";
const electronTests = [
  "packages/electron/__tests__/auto-updater.test.ts",
  "packages/electron/__tests__/build.test.ts",
  "packages/electron/__tests__/builder-config.test.ts",
  "packages/electron/__tests__/prepare-pack.test.ts",
  "packages/electron/__tests__/release-pipeline.test.ts",
];

function buildTestPlan(): VitestCommand[] {
  const tokenizerEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=6144"].filter(Boolean).join(" "),
  };
  const remainingWorkers = "1";

  return [
    // 该文件构造数千万字符的输入。独立进程退出后释放其堆，避免与其余测试文件累积。
    {
      args: [tokenizerTest, "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--testTimeout=30000"],
      env: tokenizerEnv,
    },
    // Electron 打包测试共享 release lock；每个文件独立进程，避免 beforeAll 跨文件争抢。
    ...electronTests.map((electronTest) => ({
      args: [electronTest, "--pool=forks", "--maxWorkers=1", "--minWorkers=1", "--testTimeout=300000", "--hookTimeout=300000"],
      env: process.env,
    })),
    {
      args: [
        "--exclude", tokenizerTest,
        ...electronTests.flatMap((testFile) => ["--exclude", testFile]),
        "--pool=forks", `--maxWorkers=${remainingWorkers}`, "--minWorkers=1",
      ],
      env: process.env,
    },
  ];
}

const plan = buildTestPlan();
if (process.env.TEST_RUNNER_DRY_RUN === "1") {
  console.log(JSON.stringify(plan.map(({ args, env }) => ({
    args,
    nodeOptions: env.NODE_OPTIONS ?? null,
  }))));
  process.exit(0);
}

for (const { args, env } of plan) {
  const result = spawnSync(process.execPath, [vitestEntrypoint, "run", ...args], { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
