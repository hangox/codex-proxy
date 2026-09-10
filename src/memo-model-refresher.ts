/**
 * Periodic refresh of API key memo model lists.
 *
 * Runs daily, walking all memos serially with a short pause between each.
 * Every refresh forces a live provider fetch — memos must not share the
 * URL-keyed model cache because different tokens on the same relay can
 * return different model lists. Signature-identical memos cannot exist
 * (ApiKeyMemoStore dedupes on create), so each memo gets its own fetch.
 */

import { ApiKeyModelCache } from "./auth/api-key-model-cache.js";
import type { ApiKeyMemoStore } from "./auth/api-key-memo-store.js";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const PER_MEMO_DELAY_MS = 3 * 1000;

export function refreshAllMemoModels(
  memoStore: ApiKeyMemoStore,
  modelCache: ApiKeyModelCache,
  log = console,
): Promise<{ refreshed: number; failed: number }> {
  const memos = memoStore.list();
  let refreshed = 0;
  let failed = 0;

  async function walk(index: number): Promise<void> {
    if (index >= memos.length) return;
    const memo = memos[index]!;
    try {
      const result = await modelCache.fetchModels({
        provider: memo.provider,
        apiKey: memo.apiKey,
        baseUrl: memo.provider === "custom" ? memo.baseUrl : undefined,
        wire: memo.wire,
        force: true,
      });
      memoStore.setModels(memo.id, result.models, result.fetchedAt);
      refreshed++;
    } catch (err) {
      failed++;
      log.warn?.(`[MemoRefresher] Failed to refresh "${memo.name}": ${err instanceof Error ? err.message : err}`);
    }
    if (index + 1 < memos.length) {
      await new Promise((resolve) => setTimeout(resolve, PER_MEMO_DELAY_MS));
    }
    await walk(index + 1);
  }

  return walk(0).then(() => ({ refreshed, failed }));
}

/** Start the daily memo model refresher. Returns stop(). */
export function startMemoModelRefresher(memoStore: ApiKeyMemoStore, modelCache: ApiKeyModelCache): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runCycle();
    }, REFRESH_INTERVAL_MS);
    timer.unref?.();
  };

  async function runCycle(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await refreshAllMemoModels(memoStore, modelCache);
      console.log(`[MemoRefresher] Cycle done: ${result.refreshed} refreshed, ${result.failed} failed`);
    } finally {
      running = false;
      schedule();
    }
  }

  schedule();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
