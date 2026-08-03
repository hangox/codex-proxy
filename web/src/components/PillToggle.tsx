/**
 * ★ 8.17：从 `UsageStats.tsx` 抽出来的通用胶囊按钮组——`granularity`/`range`
 * 选择器和 `CompactOutcomesCard` 的视图/时间窗口切换都在用同一套视觉语言，
 * 独立压缩明细面板（`CompactDetailPage.tsx`）需要复用同一个组件，不新发明
 * 一套样式。行为和视觉都是从 `UsageStats.tsx` 原样搬过来的，没有改动。
 */
export function PillToggle<V extends string | number>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: V; label: string }>;
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div class="flex gap-1">
      {options.map(({ value: v, label }) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
            value === v
              ? "bg-primary-action text-white border-primary-action"
              : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
