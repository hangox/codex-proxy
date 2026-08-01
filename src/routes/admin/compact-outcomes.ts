/**
 * ★ 8.12：opaque compact 快速压缩成功率 API——Dashboard 卡片的数据来源。
 *
 * GET /admin/compact-outcomes/summary — 统计聚合（按请求/按会话两个口径 +
 * 最近几条 budget_exceeded 明细），窗口可选。
 *
 * 数据来自 `compact-outcome-log.ts`（8.10 落盘），这个文件只是把
 * `getCompactOutcomeStats` 包成一个 HTTP 端点，不含任何新的统计逻辑——
 * 参数解析/校验的写法照抄 `usage-stats.ts` 的 `hours` 处理，保持两个
 * 端点行为一致，前端不用记两套约定。
 */

import { Hono } from "hono";
import { getCompactOutcomeStats } from "../shared/compact-outcome-log.js";

export function createCompactOutcomesRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/compact-outcomes/summary", (c) => {
    const hoursStr = c.req.query("hours") ?? "24";
    let hours: number | "all";
    if (hoursStr === "all") {
      hours = "all";
    } else {
      const parsedHours = Number(hoursStr);
      if (!Number.isInteger(parsedHours) || parsedHours < 1) {
        c.status(400);
        return c.json({ error: "hours must be a positive integer or all." });
      }
      hours = parsedHours;
    }

    return c.json(getCompactOutcomeStats(hours));
  });

  return app;
}
