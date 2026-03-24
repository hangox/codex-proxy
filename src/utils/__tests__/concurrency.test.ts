import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../concurrency.js";

describe("mapWithConcurrency", () => {
  it("never exceeds the concurrency limit", async () => {
    let running = 0;
    let maxRunning = 0;

    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(
      items,
      async (n) => {
        running++;
        if (running > maxRunning) maxRunning = running;
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return n * 2;
      },
      3,
    );

    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  it("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, async (n) => n * 10, 2);

    expect(results).toHaveLength(5);
    const values = results.map((r) => {
      expect(r.status).toBe("fulfilled");
      return (r as PromiseFulfilledResult<number>).value;
    });
    expect(values).toEqual([10, 20, 30, 40, 50]);
  });

  it("single failure does not affect others (allSettled semantics)", async () => {
    const items = [1, 2, 3, 4];
    const results = await mapWithConcurrency(
      items,
      async (n) => {
        if (n === 3) throw new Error("boom");
        return n;
      },
      2,
    );

    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toEqual({ status: "fulfilled", value: 2 });
    expect(results[2].status).toBe("rejected");
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[3]).toEqual({ status: "fulfilled", value: 4 });
  });

  it("works when limit exceeds items count", async () => {
    const items = [10, 20];
    const results = await mapWithConcurrency(items, async (n) => n + 1, 100);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ status: "fulfilled", value: 11 });
    expect(results[1]).toEqual({ status: "fulfilled", value: 21 });
  });

  it("returns empty array for empty input", async () => {
    const results = await mapWithConcurrency(
      [] as number[],
      async (n) => n,
      5,
    );
    expect(results).toEqual([]);
  });
});
