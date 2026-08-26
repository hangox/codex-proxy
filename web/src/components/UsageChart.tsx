/**
 * Pure SVG line chart for token usage trends.
 * No external chart library — renders smooth paths with axis labels.
 */

import { useMemo } from "preact/hooks";
import type { UsageDataPoint } from "../../../shared/hooks/use-usage-stats";
import { formatHitRate, formatUsageNumber, sumUsageWindow, sumWindow } from "../../../shared/utils/usage-stats";

export { formatHitRate, sumUsageWindow, sumWindow };
export const formatNumber = formatUsageNumber;

interface UsageChartProps {
  data: UsageDataPoint[];
  height?: number;
}

interface Point {
  x: number;
  y: number;
}

const PADDING = { top: 20, right: 20, bottom: 40, left: 65 };

export function buildSmoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`;

  const commands = [`M ${points[0].x},${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const previous = points[i - 1] ?? points[i];
    const current = points[i];
    const next = points[i + 1];
    const following = points[i + 2] ?? next;
    const control1 = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6,
    };
    const control2 = {
      x: next.x - (following.x - current.x) / 6,
      y: next.y - (following.y - current.y) / 6,
    };
    commands.push(`C ${control1.x},${control1.y} ${control2.x},${control2.y} ${next.x},${next.y}`);
  }
  return commands.join(" ");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface ComputedSeries {
  inputPath: string;
  outputPath: string;
  cachedPath: string;
  requestPath: string;
  hitRatePath: string;
  /** Per-bucket hit rate marker; null when input=0 (skip dot). */
  hitRateMarkers: Array<{ x: number; y: number; cached: number; input: number; ts: string } | null>;
  xLabels: Array<{ x: number; label: string }>;
  yTokenLabels: Array<{ y: number; label: string }>;
  yReqLabels: Array<{ y: number; label: string }>;
  yHitLabels: Array<{ y: number; label: string }>;
  toX: (i: number) => number;
  toYTokens: (v: number) => number;
  toYReqs: (v: number) => number;
  toYHit: (v: number) => number;
}

export function UsageChart({ data, height = 260 }: UsageChartProps) {
  const width = 720;
  const reqHeight = Math.round(height * 0.6);
  const hitHeight = Math.round(height * 0.6);

  const series = useMemo<ComputedSeries | null>(() => {
    if (data.length === 0) return null;

    const chartW = width - PADDING.left - PADDING.right;
    const chartH = height - PADDING.top - PADDING.bottom;
    const reqChartH = reqHeight - PADDING.top - PADDING.bottom;
    const hitChartH = hitHeight - PADDING.top - PADDING.bottom;

    const maxInput = Math.max(...data.map((d) => d.input_tokens));
    const maxOutput = Math.max(...data.map((d) => d.output_tokens));
    const maxCached = Math.max(...data.map((d) => d.cached_tokens ?? 0));
    const yMaxT = Math.max(maxInput, maxOutput, maxCached, 1);
    const yMaxR = Math.max(...data.map((d) => d.request_count), 1);
    const yMaxH = 100;

    const toX = (i: number) => PADDING.left + (i / Math.max(data.length - 1, 1)) * chartW;
    const toYTokens = (v: number) => PADDING.top + chartH - (v / yMaxT) * chartH;
    const toYReqs = (v: number) => PADDING.top + reqChartH - (v / yMaxR) * reqChartH;
    const toYHit = (v: number) => PADDING.top + hitChartH - (v / yMaxH) * hitChartH;

    const inp = data.map((d, i) => ({ x: toX(i), y: toYTokens(d.input_tokens) }));
    const out = data.map((d, i) => ({ x: toX(i), y: toYTokens(d.output_tokens) }));
    const cac = data.map((d, i) => ({ x: toX(i), y: toYTokens(d.cached_tokens ?? 0) }));
    const req = data.map((d, i) => ({ x: toX(i), y: toYReqs(d.request_count) }));

    // Connect only buckets with input > 0; gaps split the line.
    const hitSegments: string[] = [];
    let currentSegment: Point[] = [];
    const hitMarkers: ComputedSeries["hitRateMarkers"] = [];
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const inTok = d.input_tokens;
      const cachedTok = d.cached_tokens ?? 0;
      if (inTok > 0) {
        const pct = Math.min(100, (cachedTok / inTok) * 100);
        const x = toX(i);
        const y = toYHit(pct);
        currentSegment.push({ x, y });
        hitMarkers.push({ x, y, cached: cachedTok, input: inTok, ts: d.timestamp });
      } else {
        if (currentSegment.length > 0) {
          hitSegments.push(buildSmoothPath(currentSegment));
          currentSegment = [];
        }
        hitMarkers.push(null);
      }
    }
    if (currentSegment.length > 0) hitSegments.push(buildSmoothPath(currentSegment));

    const step = Math.max(1, Math.floor(data.length / 5));
    const xl = [];
    for (let i = 0; i < data.length; i += step) {
      xl.push({ x: toX(i), label: formatTime(data[i].timestamp) });
    }

    const yTL = [];
    const yRL = [];
    const yHL = [];
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      yTL.push({ y: PADDING.top + chartH - frac * chartH, label: formatNumber(Math.round(yMaxT * frac)) });
      yRL.push({ y: PADDING.top + reqChartH - frac * reqChartH, label: formatNumber(Math.round(yMaxR * frac)) });
      yHL.push({ y: PADDING.top + hitChartH - frac * hitChartH, label: `${Math.round(yMaxH * frac)}%` });
    }

    return {
      inputPath: buildSmoothPath(inp),
      outputPath: buildSmoothPath(out),
      cachedPath: buildSmoothPath(cac),
      requestPath: buildSmoothPath(req),
      hitRatePath: hitSegments.join(" "),
      hitRateMarkers: hitMarkers,
      xLabels: xl,
      yTokenLabels: yTL,
      yReqLabels: yRL,
      yHitLabels: yHL,
      toX,
      toYTokens,
      toYReqs,
      toYHit,
    };
  }, [data, height, reqHeight, hitHeight]);

  if (!series) {
    return (
      <div class="text-center py-12 text-slate-400 dark:text-text-dim text-sm">
        No usage data yet
      </div>
    );
  }

  const { inputPath, outputPath, cachedPath, requestPath, hitRateMarkers, xLabels, yTokenLabels, yReqLabels, yHitLabels, toX, toYTokens, toYReqs } = series;

  return (
    <div class="space-y-6">
      {/* Token chart */}
      <div>
        <div class="flex items-center gap-4 mb-2 text-xs text-slate-500 dark:text-text-dim">
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-blue-500 rounded" /> Input Tokens
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-emerald-500 rounded" /> Output Tokens
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-violet-500 rounded" /> Cached Tokens
          </span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          class="w-full"
          style={{ maxHeight: `${height}px` }}
        >
          {yTokenLabels.map((tick) => (
            <line
              key={`grid-${tick.y}`}
              x1={PADDING.left}
              y1={tick.y}
              x2={width - PADDING.right}
              y2={tick.y}
              stroke="currentColor"
              class="text-gray-200 dark:text-border-dark"
              stroke-width="0.5"
            />
          ))}

          {yTokenLabels.map((tick) => (
            <text
              key={`yl-${tick.y}`}
              x={PADDING.left - 8}
              y={tick.y + 3}
              text-anchor="end"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="10"
            >
              {tick.label}
            </text>
          ))}

          {xLabels.map((tick) => (
            <text
              key={`xl-${tick.x}`}
              x={tick.x}
              y={height - 8}
              text-anchor="middle"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="9"
            >
              {tick.label}
            </text>
          ))}

          <path
            d={inputPath}
            fill="none"
            stroke="var(--chart-blue)"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <path
            d={outputPath}
            fill="none"
            stroke="var(--chart-green)"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <path
            d={cachedPath}
            fill="none"
            stroke="var(--chart-violet)"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-dasharray="4 3"
          />

          {/* Single-point dots so a lone bucket is still visible */}
          {data.map((d, i) => (
            <g key={`tok-dot-${i}`}>
              <circle cx={toX(i)} cy={toYTokens(d.input_tokens)} r="2" fill="var(--chart-blue)" />
              <circle cx={toX(i)} cy={toYTokens(d.output_tokens)} r="2" fill="var(--chart-green)" />
              <circle cx={toX(i)} cy={toYTokens(d.cached_tokens ?? 0)} r="2" fill="var(--chart-violet)" />
            </g>
          ))}
        </svg>
      </div>

      {/* Request count chart */}
      <div>
        <div class="flex items-center gap-4 mb-2 text-xs text-slate-500 dark:text-text-dim">
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-amber-500 rounded" /> Requests
          </span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${reqHeight}`}
          class="w-full"
          style={{ maxHeight: `${reqHeight}px` }}
        >
          {yReqLabels.map((tick) => (
            <line
              key={`rgrid-${tick.y}`}
              x1={PADDING.left}
              y1={tick.y}
              x2={width - PADDING.right}
              y2={tick.y}
              stroke="currentColor"
              class="text-gray-200 dark:text-border-dark"
              stroke-width="0.5"
            />
          ))}

          {yReqLabels.map((tick) => (
            <text
              key={`ryl-${tick.y}`}
              x={PADDING.left - 8}
              y={tick.y + 3}
              text-anchor="end"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="10"
            >
              {tick.label}
            </text>
          ))}

          {xLabels.map((tick) => (
            <text
              key={`rxl-${tick.x}`}
              x={tick.x}
              y={reqHeight - 8}
              text-anchor="middle"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="9"
            >
              {tick.label}
            </text>
          ))}

          <path
            d={requestPath}
            fill="none"
            stroke="var(--chart-amber)"
            stroke-width="2"
            stroke-linejoin="round"
          />

          {data.map((d, i) => (
            <circle
              key={`req-dot-${i}`}
              cx={toX(i)}
              cy={toYReqs(d.request_count)}
              r="2"
              fill="var(--chart-amber)"
            />
          ))}
        </svg>
      </div>

      {/* Hit rate chart */}
      <div>
        <div class="flex items-center gap-4 mb-2 text-xs text-slate-500 dark:text-text-dim">
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-fuchsia-500 rounded" /> Hit Rate
          </span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${hitHeight}`}
          class="w-full"
          style={{ maxHeight: `${hitHeight}px` }}
        >
          {yHitLabels.map((tick) => (
            <line
              key={`hgrid-${tick.y}`}
              x1={PADDING.left}
              y1={tick.y}
              x2={width - PADDING.right}
              y2={tick.y}
              stroke="currentColor"
              class="text-gray-200 dark:text-border-dark"
              stroke-width="0.5"
            />
          ))}

          {yHitLabels.map((tick) => (
            <text
              key={`hyl-${tick.y}`}
              x={PADDING.left - 8}
              y={tick.y + 3}
              text-anchor="end"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="10"
            >
              {tick.label}
            </text>
          ))}

          {xLabels.map((tick) => (
            <text
              key={`hxl-${tick.x}`}
              x={tick.x}
              y={hitHeight - 8}
              text-anchor="middle"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="9"
            >
              {tick.label}
            </text>
          ))}

          {series.hitRatePath && (
            <path
              d={series.hitRatePath}
              fill="none"
              stroke="var(--chart-fuchsia, #d946ef)"
              stroke-width="2"
              stroke-linejoin="round"
            />
          )}

          {hitRateMarkers.map((m, i) =>
            m ? (
              <circle
                key={`hit-dot-${i}`}
                cx={m.x}
                cy={m.y}
                r="2.5"
                fill="var(--chart-fuchsia, #d946ef)"
              >
                <title>{`${formatTime(m.ts)} — ${formatHitRate(m.cached, m.input)}`}</title>
              </circle>
            ) : null,
          )}
        </svg>
      </div>
    </div>
  );
}
