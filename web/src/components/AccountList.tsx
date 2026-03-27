import { useState, useCallback, useEffect } from "preact/hooks";
import { useI18n, useT } from "../../../shared/i18n/context";
import { AccountCard } from "./AccountCard";
import { AccountImportExport } from "./AccountImportExport";
import type { Account, ProxyEntry, QuotaWarning } from "../../../shared/types";

interface AccountListProps {
  accounts: Account[];
  loading: boolean;
  onDelete: (id: string) => Promise<string | null>;
  onRefresh: () => void;
  refreshing: boolean;
  lastUpdated: Date | null;
  proxies?: ProxyEntry[];
  onProxyChange?: (accountId: string, proxyId: string) => void;
  onExport?: (selectedIds?: string[], format?: "full" | "minimal") => Promise<void>;
  onImport?: (file: File) => Promise<{ success: boolean; added: number; updated: number; failed: number; errors: string[] }>;
  onToggleStatus?: (id: string, currentStatus: string) => Promise<string | null>;
  onUpdateLabel?: (id: string, label: string | null) => Promise<string | null>;
}

const PAGE_SIZE = 10;

export function AccountList({ accounts, loading, onDelete, onRefresh, refreshing, lastUpdated, proxies, onProxyChange, onExport, onImport, onToggleStatus, onUpdateLabel }: AccountListProps) {
  const t = useT();
  const { lang } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [warnings, setWarnings] = useState<QuotaWarning[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResult, setHealthResult] = useState<{ alive: number; dead: number; skipped: number } | null>(null);
  const [hideExhausted, setHideExhausted] = useState(false);

  const runHealthCheck = useCallback(async () => {
    setHealthChecking(true);
    setHealthResult(null);
    try {
      const resp = await fetch("/auth/accounts/health-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (resp.ok) {
        const data = await resp.json();
        setHealthResult(data.summary);
        setTimeout(() => setHealthResult(null), 8000);
      }
      onRefresh();
    } finally {
      setHealthChecking(false);
    }
  }, [onRefresh]);

  // Poll quota warnings
  useEffect(() => {
    const fetchWarnings = async () => {
      try {
        const resp = await fetch("/auth/quota/warnings");
        const data = await resp.json();
        setWarnings(data.warnings || []);
      } catch { /* ignore */ }
    };
    fetchWarnings();
    const timer = setInterval(fetchWarnings, 30_000);
    return () => clearInterval(timer);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === accounts.length) return new Set();
      return new Set(accounts.map((a) => a.id));
    });
  }, [accounts]);

  const updatedAtText = lastUpdated
    ? lastUpdated.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  const activeCount = accounts.filter((a) => a.status === "active").length;

  const isExhausted = (a: Account) =>
    a.quota?.rate_limit?.limit_reached === true || a.status === "rate_limited";
  const exhaustedCount = accounts.filter(isExhausted).length;
  const displayAccounts = hideExhausted ? accounts.filter((a) => !isExhausted(a)) : accounts;

  return (
    <section class="flex flex-col gap-4">
      {/* Row 1: Title + stats */}
      <div class="flex items-start justify-between">
        <div class="flex flex-col gap-1">
          <h2 class="text-[0.95rem] font-bold tracking-tight">{t("connectedAccounts")}</h2>
          <p class="text-slate-500 dark:text-text-dim text-[0.8rem]">{t("connectedAccountsDesc")}</p>
        </div>
        <div class="flex flex-col items-end gap-1 shrink-0">
          <span class="text-[0.82rem] font-semibold">
            <span class="text-primary">{activeCount}</span>
            <span class="text-slate-400 dark:text-text-dim"> / {accounts.length}</span>
          </span>
          {updatedAtText && (
            <span class="text-[0.7rem] text-slate-400 dark:text-text-dim">
              {t("updatedAt")} {updatedAtText}
            </span>
          )}
        </div>
      </div>

      {/* Action toolbar */}
      <div class="flex items-center gap-1.5 flex-wrap">
        {/* Refresh list */}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-primary hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          <span class="hidden sm:inline">{t("refreshList")}</span>
        </button>
        {/* Health check (batch token refresh) */}
        <button
          onClick={runHealthCheck}
          disabled={healthChecking}
          class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg class={`size-3.5 ${healthChecking ? "animate-pulse" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
          </svg>
          <span class="hidden sm:inline">{healthChecking ? t("healthChecking") : t("healthCheck")}</span>
        </button>
        {/* Import / Export */}
        {onExport && onImport && (
          <AccountImportExport onExport={onExport} onImport={onImport} selectedIds={selectedIds} />
        )}
        {/* Select all */}
        {accounts.length > 0 && (
          <button
            onClick={toggleSelectAll}
            class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-primary hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              {selectedIds.size === accounts.length ? (
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              ) : (
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              )}
            </svg>
            <span class="hidden sm:inline">{selectedIds.size === accounts.length ? t("deselectAll") : t("selectAll")}</span>
          </button>
        )}
        {/* Hide exhausted toggle */}
        {exhaustedCount > 0 && (
          <button
            onClick={() => setHideExhausted((v) => !v)}
            class={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              hideExhausted
                ? "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20"
                : "text-slate-600 dark:text-text-dim hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20"
            }`}
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              {hideExhausted ? (
                <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
              ) : (
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              )}
            </svg>
            <span class="hidden sm:inline">
              {hideExhausted
                ? t("hideExhaustedOn").replace("{count}", String(exhaustedCount))
                : t("hideExhaustedOff").replace("{count}", String(exhaustedCount))}
            </span>
          </button>
        )}
        {/* Pagination — right side */}
        {!loading && displayAccounts.length > PAGE_SIZE && (
          <div class="flex items-center gap-2 ml-auto pl-3 border-l border-gray-200 dark:border-border-dark">
            <span class="text-xs text-slate-400 dark:text-text-dim tabular-nums">
              {Math.min(visibleCount, displayAccounts.length)} / {displayAccounts.length}
            </span>
            {visibleCount < displayAccounts.length ? (
              <button
                onClick={() => setVisibleCount(displayAccounts.length)}
                class="px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors"
              >
                {t("expandAll")}
              </button>
            ) : (
              <button
                onClick={() => setVisibleCount(PAGE_SIZE)}
                class="px-2.5 py-1 text-xs font-medium text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors"
              >
                {t("collapse")}
              </button>
            )}
          </div>
        )}
      </div>
      {/* Health check result banner */}
      {healthResult && (
        <div class={`px-4 py-2.5 rounded-lg text-sm flex items-center gap-2 ${
          healthResult.dead > 0
            ? "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 text-red-700 dark:text-red-400"
            : "bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30 text-emerald-700 dark:text-emerald-400"
        }`}>
          <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
          </svg>
          <span>
            {t("healthCheckResult")
              .replace("{alive}", String(healthResult.alive))
              .replace("{dead}", String(healthResult.dead))
              .replace("{skipped}", String(healthResult.skipped))}
          </span>
        </div>
      )}
      {/* Quota warning banners */}
      {warnings.filter((w) => w.level === "critical").length > 0 && (
        <div class="px-4 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <span>
            {t("quotaCriticalWarning").replace("{count}", String(warnings.filter((w) => w.level === "critical").length))}
          </span>
        </div>
      )}
      {warnings.filter((w) => w.level === "warning").length > 0 && warnings.filter((w) => w.level === "critical").length === 0 && (
        <div class="px-4 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 text-amber-700 dark:text-amber-400 text-sm flex items-center gap-2">
          <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <span>
            {t("quotaWarning").replace("{count}", String(warnings.filter((w) => w.level === "warning").length))}
          </span>
        </div>
      )}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading ? (
          <div class="md:col-span-2 text-center py-8 text-slate-400 dark:text-text-dim text-sm bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl transition-colors">
            {t("loadingAccounts")}
          </div>
        ) : displayAccounts.length === 0 ? (
          <div class="md:col-span-2 text-center py-8 text-slate-400 dark:text-text-dim text-sm bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl transition-colors">
            {hideExhausted && accounts.length > 0 ? t("allExhausted") : t("noAccounts")}
          </div>
        ) : (
          displayAccounts.slice(0, visibleCount).map((acct, i) => (
            <AccountCard key={acct.id} account={acct} index={i} onDelete={onDelete} proxies={proxies} onProxyChange={onProxyChange} selected={selectedIds.has(acct.id)} onToggleSelect={toggleSelect} onRefreshQuota={async (id) => { await fetch(`/auth/accounts/${encodeURIComponent(id)}/refresh`, { method: "POST" }); onRefresh(); }} onToggleStatus={onToggleStatus} onUpdateLabel={onUpdateLabel} />
          ))
        )}
      </div>
      {/* Show more at bottom when partially expanded */}
      {!loading && displayAccounts.length > PAGE_SIZE && visibleCount < displayAccounts.length && visibleCount > PAGE_SIZE && (
        <div class="flex items-center justify-center mt-2">
          <button
            onClick={() => setVisibleCount((c) => Math.min(c + PAGE_SIZE, displayAccounts.length))}
            class="px-4 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
          >
            {t("showMore")}
          </button>
        </div>
      )}
    </section>
  );
}
