import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@src": resolve(__dirname, "src"),
      "@helpers": resolve(__dirname, "tests/_helpers"),
      "@fixtures": resolve(__dirname, "tests/_fixtures"),
    },
  },
  test: {
    environment: "node",
    // 派生子进程的测试彼此并行时会争抢 CPU，造成互相超时的假失败
    // （opaque 故障注入要为每个用例启动 `node --import tsx`，
    // update-scripts-path 同样派生子进程）。把它们放进单线程 forks 池
    // 串行执行；这是资源隔离，与被测逻辑无关。
    poolMatchGlobs: [
      ["**/opaque-compact-fault-injection.test.ts", "forks"],
      ["**/update-scripts-path.test.ts", "forks"],
    ],
    poolOptions: {
      forks: { singleFork: true },
    },
    include: [
      "shared/**/*.{test,spec}.ts",
      "tests/unit/**/*.{test,spec}.ts",
      "tests/integration/**/*.{test,spec}.ts",
      "tests/e2e/**/*.{test,spec}.ts",
      "packages/electron/__tests__/**/*.{test,spec}.ts",
    ],
  },
});
