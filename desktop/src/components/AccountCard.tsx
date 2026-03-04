import { useCallback } from "preact/hooks";
import { useT, useI18n } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import { formatNumber, formatResetTime, formatWindowDuration } from "../../../shared/utils/format";
import type { Account } from "../../../shared/types";

const avatarColors = [
  ["bg-purple-100 dark:bg-purple-900/30", "text-purple-600 dark:text-purple-400"],
  ["bg-amber-100 dark:bg-amber-900/30", "text-amber-600 dark:text-amber-400"],
  ["bg-blue-100 dark:bg-blue-900/30", "text-blue-600 dark:text-blue-400"],
  ["bg-emerald-100 dark:bg-emerald-900/30", "text-emerald-600 dark:text-emerald-400"],
  ["bg-rose-100 dark:bg-rose-900/30", "text-rose-600 dark:text-rose-400"],
];

const statusStyles: Record<string, [string, string]> = {
  active: [
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/40",
    "active",
  ],
  expired: [
    "bg-red-50 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/40",
    "expired",
  ],
  rate_limited: [
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/40",
    "rateLimited",
  ],
  refreshing: [
    "bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800/40",
    "refreshing",
  ],
  disabled: [
    "bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-800/30 dark:text-gray-400 dark:border-gray-700/40",
    "disabled",
  ],
};

interface AccountCardProps {
  account: Account;
  index: number;
  onDelete: (id: string) => Promise<string | null>;
}

export function AccountCard({ account, index, onDelete }: AccountCardProps) {
  const t = useT();
  const { lang } = useI18n();
  const email = account.email || "Unknown";
  const initial = email.charAt(0).toUpperCase();
  const [bgColor, textColor] = avatarColors[index % avatarColors.length];
  const usage = account.usage || {};
  const requests = usage.request_count ?? 0;
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  const winRequests = usage.window_request_count ?? 0;
  const winTokens = (usage.window_input_tokens ?? 0) + (usage.window_output_tokens ?? 0);
  const plan = account.planType || t("freeTier");
  const windowSec = account.quota?.rate_limit?.limit_window_seconds;
  const windowDur = windowSec ? formatWindowDuration(windowSec, lang === "zh") : null;

  const [statusCls, statusKey] = statusStyles[account.status] || statusStyles.disabled;

  const handleDelete = useCallback(async () => {
    if (!confirm(t("removeConfirm"))) return;
    const err = await onDelete(account.id);
    if (err) alert(err);
  }, [account.id, onDelete, t]);

  const q = account.quota;
  const rl = q?.rate_limit;
  const pct = rl?.used_percent != null ? Math.round(rl.used_percent) : null;
  const barColor =
    pct == null ? "bg-primary" : pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-primary";
  const pctColor =
    pct == null
      ? "text-primary"
      : pct >= 90
        ? "text-red-500"
        : pct >= 60
          ? "text-amber-500"
          : "text-primary";
  const resetAt = rl?.reset_at ? formatResetTime(rl.reset_at, lang === "zh") : null;

  return (
    <div class="card p-5 hover:border-primary/30">
      {/* Header row */}
      <div class="flex justify-between items-start mb-4">
        <div class="flex items-center gap-3">
          <div class={`size-10 rounded-[var(--radius-card)] ${bgColor} ${textColor} flex items-center justify-center font-bold text-base`}>
            {initial}
          </div>
          <div>
            <h3 class="text-[0.82rem] font-semibold leading-tight" style="color: var(--text-primary);">{email}</h3>
            <p class="text-xs mt-0.5" style="color: var(--text-secondary);">
              {plan}
              {windowDur && (
                <span class="ml-1.5 px-1.5 py-0.5 rounded text-[0.65rem] font-medium" style="background: var(--bg-input); color: var(--text-secondary);">
                  {windowDur}
                </span>
              )}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class={`px-2.5 py-1 rounded-full ${statusCls} text-xs font-medium border`}>
            {t(statusKey as TranslationKey)}
          </span>
          <button
            onClick={handleDelete}
            class="p-1.5 rounded-md transition-colors duration-150 hover:bg-red-50 dark:hover:bg-red-900/20"
            style="color: var(--text-tertiary);"
            title={t("deleteAccount")}
          >
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      {/* Stats */}
      <div class="space-y-2">
        <div class="flex justify-between text-[0.78rem]">
          <span style="color: var(--text-secondary);">{t("windowRequests")}</span>
          <span class="font-medium" style="color: var(--text-primary);">{formatNumber(winRequests)}</span>
        </div>
        <div class="flex justify-between text-[0.78rem]">
          <span style="color: var(--text-secondary);">{t("windowTokens")}</span>
          <span class="font-medium" style="color: var(--text-primary);">{formatNumber(winTokens)}</span>
        </div>
        <div class="flex justify-between text-[0.68rem]">
          <span style="color: var(--text-tertiary);">{t("totalAll")}</span>
          <span style="color: var(--text-tertiary);">{formatNumber(requests)} req · {formatNumber(tokens)} tok</span>
        </div>
      </div>

      {/* Quota bar */}
      {rl && (
        <div class="pt-3 mt-3" style="border-top: 1px solid var(--border);">
          <div class="flex justify-between text-[0.78rem] mb-1.5">
            <span style="color: var(--text-secondary);">{t("rateLimit")}</span>
            {rl.limit_reached ? (
              <span class="px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs font-medium">
                {t("limitReached")}
              </span>
            ) : pct != null ? (
              <span class={`font-medium ${pctColor}`}>{pct}% {t("used")}</span>
            ) : (
              <span class="font-medium text-primary">{t("ok")}</span>
            )}
          </div>
          {pct != null && (
            <div class="w-full h-2 rounded-full overflow-hidden" style="background: var(--bg-input);">
              <div class={`${barColor} h-2 rounded-full transition-all duration-300`} style={{ width: `${pct}%` }} />
            </div>
          )}
          {resetAt && (
            <p class="text-xs mt-1" style="color: var(--text-tertiary);">
              {t("resetsAt")} {resetAt}
              {windowDur && (
                <span class="ml-1" style="color: var(--text-tertiary);">
                  ({t("windowLabel")} {windowDur})
                </span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
