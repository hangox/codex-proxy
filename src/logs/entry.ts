import { randomUUID } from "crypto";
import { logStore, type LogDirection } from "./store.js";

export function enqueueLogEntry(entry: {
  requestId: string;
  direction: LogDirection;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  error?: string | null;
  request?: unknown;
  response?: unknown;
}): void {
  logStore.enqueue({
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...entry,
  });
}
