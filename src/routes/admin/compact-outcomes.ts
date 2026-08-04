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
 *
 * ★ #108：两个端点新增 `compact_path` query 参数，但**默认口径刻意相反**
 * ——别看到两处不一致就当成手滑，理由必须分开写清楚，各自就近放在定义
 * 默认值的地方（下面对应的两个 handler 里）：`/summary` 是有明确指标定义
 * 的聚合数字，默认排除 `fallback_render`；`/events` 是原始明细列表，默认
 * 展示全部路径，这正是这次改动要做的事（用户原话："降级后的压缩也在这里
 * 统一展示"）。
 *
 * ★ #108（team-lead 批准"排除 fallback_render"时的附加条件，不是可选项，
 * 原话："只排除不提供替代，会直接落空用户的核心诉求"）：`/summary`
 * 响应体额外并列一个 `render` 键——同一次请求里，opaque 那组口径
 * （`by_request`/`by_session`，不变）和 render 那组口径并排返回，前端不用
 * 再单独发一次带 `compact_path=fallback_render` 的请求就能把两组数字对比
 * 展示。这不是替换 `compact_path` 参数（那个参数依然保留，用于单独查
 * 某一条具体路径），是在默认响应之外**额外**附加。
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getCompactOutcomeStats,
  queryCompactOutcomeEvents,
  type CompactOutcome,
  type CompactPath,
} from "../shared/compact-outcome-log.js";

const KNOWN_OUTCOMES: readonly CompactOutcome[] = [
  "success", "budget_exceeded", "upstream_failed", "denied", "render_completed",
];

function isCompactOutcome(value: string): value is CompactOutcome {
  return (KNOWN_OUTCOMES as readonly string[]).includes(value);
}

const KNOWN_COMPACT_PATHS: readonly CompactPath[] = ["opaque", "fallback_decision", "fallback_render"];

function isCompactPath(value: string): value is CompactPath {
  return (KNOWN_COMPACT_PATHS as readonly string[]).includes(value);
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

    const compactPathRaw = c.req.query("compact_path");
    let compactPathFilter: CompactPath | "all" | undefined;
    if (compactPathRaw !== undefined) {
      if (compactPathRaw !== "all" && !isCompactPath(compactPathRaw)) {
        c.status(400);
        return c.json({ error: `compact_path must be one of: all, ${KNOWN_COMPACT_PATHS.join(", ")}.` });
      }
      compactPathFilter = compactPathRaw as CompactPath | "all";
    }
    // ★ #108：不传 compact_path 时，默认口径必须排除 fallback_render——
    // 这张卡片统计的是"opaque 压缩成功率"这个特定指标（分母历史上一直是
    // success/denied/budget_exceeded/upstream_failed 四类，它们都描述
    // "一次 opaque 尝试"）。fallback_render 描述的是完全不同的问题——
    // "opaque 失败降级之后，换端点重试的那次压缩自己成不成功"——混进同一个
    // 分母会稀释、悄悄改变这张卡片一直以来的数字。不传时让
    // getCompactOutcomeStats 走它自己的默认口径（同样排除 fallback_render，
    // 两处理由相同，是同一件事，不是重复决策）；要看 fallback_render 的
    // 统计，显式传 compact_path=fallback_render 或 compact_path=all。
    const stats = getCompactOutcomeStats(parsedHours.hours, 10, model, undefined, compactPathFilter);

    // ★ #108：并列组，见文件头注释——不管上面 compact_path 参数传了什么，
    // 这里都额外算一次"只看 fallback_render"的聚合，塞进 render 键。刻意
    // 用同一个 model/hours 参数，保证 opaque 那组和 render 那组的时间窗口/
    // 型号筛选是同一套条件，两组数字才能真的放在一起比（不会出现"opaque
    // 那组筛了某个型号，render 那组却是全部型号"这种口径不一致）。
    // recent_budget_exceeded 不放进 render 组——fallback_render 路径不会
    // 产生 budget_exceeded outcome（那是 opaque 预算预判特有的概念），塞
    // 一个恒为空数组的字段没有信息量。
    const renderStats = getCompactOutcomeStats(parsedHours.hours, 10, model, undefined, "fallback_render");
    return c.json({
      ...stats,
      render: { by_request: renderStats.by_request, by_session: renderStats.by_session },
    });
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

    // ★ #108：不传时不做任何 compact_path 过滤——三条路径全部摊平展示，
    // 这正是明细面板要统一展示 opaque 和降级两条路径、方便对比的目的
    // （用户原话见文件头注释）。跟 /summary 默认排除 fallback_render 刻意
    // 相反：那边是有明确指标定义的聚合数字，这里是原始明细列表，本来就该
    // 有什么就展示什么。
    const compactPathStr = c.req.query("compact_path");
    if (compactPathStr !== undefined && !isCompactPath(compactPathStr)) {
      c.status(400);
      return c.json({ error: `compact_path must be one of: ${KNOWN_COMPACT_PATHS.join(", ")}.` });
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
      compactPath: compactPathStr,
      limit: parsedQuery.data.limit,
      offset: parsedQuery.data.offset,
    }));
  });

  return app;
}
