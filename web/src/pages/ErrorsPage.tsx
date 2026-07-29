import { useState } from "preact/hooks";
import {
  useErrorLogs,
  formatRelativeTime,
  type ErrorGroup,
} from "../../../shared/hooks/use-error-logs";
import { useT } from "../../../shared/i18n/context";

function sourceBadgeClass(source: string): string {
  switch (source) {
    case "main":
      return "bg-avatar-purple-bg text-avatar-purple-text border-avatar-purple-text/30";
    case "renderer":
      return "bg-info-container text-info border-info/30";
    case "server":
      return "bg-success-container text-success border-success/30";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300";
  }
}

function hasContext(group: ErrorGroup): boolean {
  return group.sample_context !== undefined && Object.keys(group.sample_context).length > 0;
}

export interface CompactFallbackSummary {
  count: number;
  lastSeen: string;
  lastModel: string | null;
  lastInputItems: number | null;
  lastErrorMessage: string | null;
  lastRetryCount: number | null;
}

/**
 * 用户在会话内完全看不到 compact 是否静默降级——这个 banner 是"事后可查"
 * 的另一条腿（另一条是 x-codex-proxy-compact-fallback 响应 header）。
 *
 * 复用现有的 `/admin/error-logs` 分组数据，不新开接口：`recordOpaqueCompactFallback`
 * 写进 error-log.jsonl 的记录 `error.name` 恒为 `"OpaqueCompactFallback"`，
 * `groupErrorLog` 按 `name + 首个 stack frame` 分组——这类记录没有 stack，
 * 所以全部落进同一组，`count` 就是发生次数，`sample_context` 是最近一次
 * 事件的完整上下文（`rid`/`model`/`input_items`/`error_message`/`retry_count`
 * 等，见 opaque-compact-fallback-log.ts）。
 *
 * 没有做"成功/降级比率"：那需要额外给每次成功的 compact 也记一条结构化
 * 事件（`appendErrorLog` 语义上是错误日志，不适合塞成功计数），是一个新的
 * 埋点面，不是"复用现有数据"能低成本做到的，这次刻意不做，只给命中次数
 * 和时间。
 */
export function computeCompactFallbackSummary(groups: ErrorGroup[]): CompactFallbackSummary | null {
  const group = groups.find((g) => g.name === "OpaqueCompactFallback");
  if (!group) return null;
  const ctx = group.sample_context ?? {};
  return {
    count: group.count,
    lastSeen: group.last_seen,
    lastModel: typeof ctx.model === "string" ? ctx.model : null,
    lastInputItems: typeof ctx.input_items === "number" ? ctx.input_items : null,
    lastErrorMessage: typeof ctx.error_message === "string" ? ctx.error_message : null,
    lastRetryCount: typeof ctx.retry_count === "number" ? ctx.retry_count : null,
  };
}

function ErrorRow({ group }: { group: ErrorGroup }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const showContext = hasContext(group);
  return (
    <div class="rounded-xl border border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark transition-colors">
      <button
        onClick={() => setOpen((o) => !o)}
        class="w-full flex items-start justify-between gap-3 p-4 text-left"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-sm font-mono font-semibold text-slate-800 dark:text-text-main truncate">
              {group.name}
            </span>
            <span
              class={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide ${sourceBadgeClass(group.source)}`}
            >
              {group.source}
            </span>
            {group.count > 1 && (
              <span class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-danger-container text-danger border border-danger/30 text-[10px] font-semibold">
                ×{group.count}
              </span>
            )}
          </div>
          <p class="text-xs text-slate-600 dark:text-text-dim truncate">
            {group.message}
          </p>
          <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
            {t("errorLastSeen")}: {formatRelativeTime(group.last_seen)}
          </p>
        </div>
        <svg
          class={`size-4 text-slate-400 dark:text-slate-500 mt-1 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (group.sample_stack || showContext) && (
        <div class="px-4 pb-4 border-t border-gray-100 dark:border-border-dark/50">
          {showContext && (
            <pre class="mt-3 text-[11px] font-mono whitespace-pre-wrap break-all text-slate-600 dark:text-text-dim leading-relaxed bg-slate-50 dark:bg-bg-dark/40 rounded-lg p-3 overflow-x-auto">
              {JSON.stringify(group.sample_context, null, 2)}
            </pre>
          )}
          {group.sample_stack && (
            <pre class="mt-3 text-[11px] font-mono whitespace-pre-wrap break-all text-slate-600 dark:text-text-dim leading-relaxed bg-slate-50 dark:bg-bg-dark/40 rounded-lg p-3 overflow-x-auto">
              {group.sample_stack}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function CompactFallbackBanner({ summary }: { summary: CompactFallbackSummary }) {
  const t = useT();
  return (
    <div class="rounded-xl border border-amber-200 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/10 p-4">
      <div class="flex items-center gap-2">
        <svg class="size-4 text-amber-600 dark:text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
        <span class="text-sm font-semibold text-amber-800 dark:text-amber-300">
          {t("compactFallbackBannerTitle")}
        </span>
      </div>
      <p class="text-xs text-amber-700 dark:text-amber-400 mt-1.5">
        {t("compactFallbackBannerDesc", { count: summary.count, time: formatRelativeTime(summary.lastSeen) })}
      </p>
      <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px] text-amber-700/90 dark:text-amber-400/90">
        {summary.lastModel && (
          <>
            <dt class="font-medium">{t("compactFallbackBannerModel")}:</dt>
            <dd class="font-mono truncate">{summary.lastModel}</dd>
          </>
        )}
        {summary.lastInputItems !== null && (
          <>
            <dt class="font-medium">{t("compactFallbackBannerScale")}:</dt>
            <dd class="font-mono">{summary.lastInputItems}</dd>
          </>
        )}
        {summary.lastRetryCount !== null && (
          <>
            <dt class="font-medium">{t("compactFallbackBannerRetries")}:</dt>
            <dd class="font-mono">{summary.lastRetryCount}</dd>
          </>
        )}
        {summary.lastErrorMessage && (
          <>
            <dt class="font-medium">{t("compactFallbackBannerReason")}:</dt>
            <dd class="font-mono break-all">{summary.lastErrorMessage}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function ErrorsPage() {
  const t = useT();
  const { groups, count, loading, error, refresh, markAllSeen, clearAll } = useErrorLogs();
  const compactFallbackSummary = computeCompactFallbackSummary(groups);

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold text-slate-800 dark:text-text-main">
            {t("errorsTab")}
          </h2>
          <p class="text-xs text-slate-500 dark:text-text-dim mt-0.5">
            {t("errorsTabDesc")}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            onClick={() => void refresh()}
            class="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-border-dark text-xs font-medium text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
          >
            {t("errorsRefresh")}
          </button>
          {count.unread > 0 && (
            <button
              onClick={() => void markAllSeen()}
              class="px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold transition-colors"
            >
              {t("errorsMarkSeen")} ({count.unread})
            </button>
          )}
          {groups.length > 0 && (
            <button
              type="button"
              onClick={() => void clearAll()}
              aria-label={t("errorsClear")}
              title={t("errorsClear")}
              class="inline-flex size-8 items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-700/30 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 6V4h8v2" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 6l-1 14H6L5 6" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M10 11v5m4-5v5" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {compactFallbackSummary && <CompactFallbackBanner summary={compactFallbackSummary} />}

      {loading && groups.length === 0 && (
        <div class="text-center text-xs text-slate-400 dark:text-text-dim py-8">
          {t("loading")}
        </div>
      )}

      {error && (
        <div class="px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-700/30 dark:text-red-400 text-xs">
          {error}
        </div>
      )}

      {!loading && groups.length === 0 && !error && (
        <div class="rounded-xl border border-dashed border-gray-200 dark:border-border-dark p-8 text-center">
          <div class="inline-flex items-center justify-center size-10 rounded-full bg-success-container text-success mb-3">
            <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p class="text-sm font-medium text-slate-700 dark:text-text-main">
            {t("errorsNone")}
          </p>
          <p class="text-xs text-slate-500 dark:text-text-dim mt-1">
            {t("errorsNoneDesc")}
          </p>
        </div>
      )}

      <div class="flex flex-col gap-2">
        {groups.map((g) => (
          <ErrorRow key={g.signature} group={g} />
        ))}
      </div>
    </section>
  );
}
