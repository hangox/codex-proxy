/**
 * ★ 8.17：从 `UsageStats.tsx` 抽出来的通用胶囊按钮组——`granularity`/`range`
 * 选择器和 `CompactOutcomesCard` 的视图/时间窗口切换都在用同一套视觉语言，
 * 独立压缩明细面板（`CompactDetailPage.tsx`）需要复用同一个组件，不新发明
 * 一套样式。行为和视觉都是从 `UsageStats.tsx` 原样搬过来的，没有改动。
 *
 * ★ task #109（team-lead 建议）：新增可选的逐项 `muted` 标记——纯附加，
 * 不传时行为/视觉跟之前完全一样。用途是"这个选项当前时间窗口内没有数据"
 * 这种弱提示（比如压缩路径筛选里某条路径这次窗口内一条记录都没有）：
 * 仍然可点，不是 disabled——用户选中它照样能看到"没有匹配记录"的空状态，
 * 只是提前用更淡的视觉告诉他"大概率是这个原因，不是筛选坏了"。不做成
 * disabled 是刻意的：disabled 会让用户以为这个选项本身不可用，但它其实
 * 随时可能因为新事件写入而变得有数据，锁死交互没有必要。
 */
export function PillToggle<V extends string | number>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: V; label: string; muted?: boolean }>;
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div class="flex gap-1">
      {options.map(({ value: v, label, muted }) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
            value === v
              ? "bg-primary-action text-white border-primary-action"
              : `bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50 ${muted ? "opacity-50" : ""}`
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
