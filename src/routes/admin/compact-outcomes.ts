/**
 * ★ 8.12：opaque compact 快速压缩成功率 API——Dashboard 卡片的数据来源。
 *
 * GET /admin/compact-outcomes/summary — 统计聚合（按请求/按会话两个口径 +
 * 最近几条 budget_exceeded 明细），窗口可选，★ 8.17 起可选按型号过滤。
 *
 * ★ 8.17：GET /admin/compact-outcomes/events — 压缩明细面板的列表数据源，
 * 全量原始事件按时间倒序分页，可选按结果类型/型号筛。和 `/summary` 共享
 * 同一套 `hours`/`model` 参数语义——明细面板的汇总区和列表区用同一个时间
 * 窗口 + 型号筛选调这两个端点，两边的数字因此始终对得上，不会出现"汇总
 * 说 4 次降级、列表里筛不出对应记录"这种不一致。
 *
 * 数据来自 `compact-outcome-log.ts`（8.10 落盘），这个文件只是把
 * `getCompactOutcomeStats`/`queryCompactOutcomeEvents` 包成 HTTP 端点，
 * 不含任何新的统计/查询逻辑——参数解析/校验的写法照抄 `usage-stats.ts`
 * 的 `hours` 处理和 `admin/logs.ts` 的 `limit`/`offset` 处理，保持端点
 * 之间行为一致，前端不用记好几套约定。
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getCompactOutcomeStats,
  queryCompactOutcomeEvents,
  type CompactOutcome,
} from "../shared/compact-outcome-log.js";

const KNOWN_OUTCOMES: readonly CompactOutcome[] = ["success", "budget_exceeded", "upstream_failed", "denied"];

function isCompactOutcome(value: string): value is CompactOutcome {
  return (KNOWN_OUTCOMES as readonly string[]).includes(value);
}

/** 解析 `hours` query 参数，`/summary` 和 `/events` 共用同一套规则。 */
function parseHours(raw: string | undefined): { hours: number | "all" } | { error: string } {
  const hoursStr = raw ?? "24";
  if (hoursStr === "all") return { hours: "all" };
  const parsedHours = Number(hoursStr);
  if (!Number.isInteger(parsedHours) || parsedHours < 1) {
    return { error: "hours must be a positive integer or all." };
  }
  return { hours: parsedHours };
}

const EventsQuerySchema = z.object({
  limit: z.preprocess((value) => value === undefined ? undefined : Number(value), z.number().int().min(1).max(200).optional()),
  offset: z.preprocess((value) => value === undefined ? undefined : Number(value), z.number().int().min(0).optional()),
});

export function createCompactOutcomesRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/compact-outcomes/summary", (c) => {
    const parsedHours = parseHours(c.req.query("hours"));
    if ("error" in parsedHours) {
      c.status(400);
      return c.json({ error: parsedHours.error });
    }
    const model = c.req.query("model");
    return c.json(getCompactOutcomeStats(parsedHours.hours, 10, model));
  });

  app.get("/admin/compact-outcomes/events", (c) => {
    const parsedHours = parseHours(c.req.query("hours"));
    if ("error" in parsedHours) {
      c.status(400);
      return c.json({ error: parsedHours.error });
    }

    const outcomeStr = c.req.query("outcome");
    if (outcomeStr !== undefined && !isCompactOutcome(outcomeStr)) {
      c.status(400);
      return c.json({ error: `outcome must be one of: ${KNOWN_OUTCOMES.join(", ")}.` });
    }

    const parsedQuery = EventsQuerySchema.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsedQuery.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsedQuery.error.issues });
    }

    const model = c.req.query("model");
    const convHashPrefix = c.req.query("conv_hash_prefix");
    return c.json(queryCompactOutcomeEvents({
      windowHours: parsedHours.hours,
      outcome: outcomeStr,
      model,
      convHashPrefix,
      limit: parsedQuery.data.limit,
      offset: parsedQuery.data.offset,
    }));
  });

  return app;
}
