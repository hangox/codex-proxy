import { getConfig } from "../../config.js";
import { jitterInt } from "../../utils/jitter.js";

export interface StaggerDeps {
  intervalMs: () => number | null;
  nowMs: () => number;
  jitterInt: (baseMs: number, ratio: number) => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: StaggerDeps = {
  intervalMs: () => getConfig().auth.request_interval_ms,
  nowMs: () => Date.now(),
  jitterInt,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Sleep if this account had a recent request, to stagger upstream traffic. */
export async function staggerIfNeeded(
  prevSlotMs: number | null,
  deps: Partial<StaggerDeps> = {},
  signal?: AbortSignal,
): Promise<void> {
  const intervalMs = (deps.intervalMs ?? defaultDeps.intervalMs)();
  if (!intervalMs || prevSlotMs == null) return;
  const elapsed = (deps.nowMs ?? defaultDeps.nowMs)() - prevSlotMs;
  const target = (deps.jitterInt ?? defaultDeps.jitterInt)(intervalMs, 0.3);
  const wait = target - elapsed;
  if (wait <= 0) return;
  if (!signal) {
    await (deps.sleep ?? defaultDeps.sleep)(wait);
    return;
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, wait);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
