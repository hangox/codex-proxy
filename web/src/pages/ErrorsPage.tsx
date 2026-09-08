import { useState } from "preact/hooks";
import {
  useErrorLogs,
  formatRelativeTime,
  type ErrorGroup,
} from "../../../shared/hooks/use-error-logs";
import { useT } from "../../../shared/i18n/context";
import { accountToolbarControlClass, accountToolbarIconClass } from "../lib/account-toolbar";

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

export function ErrorsPage() {
  const t = useT();
  const { groups, count, loading, error, refresh, markAllSeen, clearAll } = useErrorLogs();

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
            class={accountToolbarIconClass}
            title={t("errorsRefresh")}
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
          {count.unread > 0 && (
            <button
              onClick={() => void markAllSeen()}
              class={accountToolbarControlClass}
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
              <span class="hidden sm:inline">{t("errorsMarkSeen")} ({count.unread})</span>
            </button>
          )}
          {groups.length > 0 && (
            <button
              type="button"
              onClick={() => void clearAll()}
              aria-label={t("errorsClear")}
              title={t("errorsClear")}
              class={accountToolbarIconClass}
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
