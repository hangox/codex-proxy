import { useT } from "../../../shared/i18n/context";
import { CopyButton } from "./CopyButton";
import { useCallback } from "preact/hooks";
import type { ModelFamily } from "../../../shared/hooks/use-status";

interface ApiConfigProps {
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  modelFamilies: ModelFamily[];
  selectedEffort: string;
  onEffortChange: (effort: string) => void;
  selectedSpeed: string | null;
  onSpeedChange: (speed: string | null) => void;
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

export function ApiConfig({
  baseUrl,
  apiKey,
  models,
  selectedModel,
  onModelChange,
  modelFamilies,
  selectedEffort,
  onEffortChange,
  selectedSpeed,
  onSpeedChange,
}: ApiConfigProps) {
  const t = useT();

  const getBaseUrl = useCallback(() => baseUrl, [baseUrl]);
  const getApiKey = useCallback(() => apiKey, [apiKey]);

  const handleFamilySelect = useCallback(
    (family: ModelFamily) => {
      onModelChange(family.id);
      const supportedEfforts = family.efforts.map((e) => e.reasoningEffort);
      if (!supportedEfforts.includes(selectedEffort)) {
        onEffortChange(family.defaultEffort);
      }
    },
    [onModelChange, onEffortChange, selectedEffort],
  );

  const currentFamily = modelFamilies.find((f) => f.id === selectedModel);
  const currentEfforts = currentFamily?.efforts ?? [];
  const showMatrix = modelFamilies.length > 0;

  return (
    <div class="card p-6">
      <div class="flex items-center gap-2 mb-6 pb-4" style="border-bottom: 1px solid var(--border);">
        <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <h2 class="text-[0.95rem] font-semibold" style="color: var(--text-primary);">{t("apiConfig")}</h2>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Base URL */}
        <div class="space-y-1.5">
          <label class="text-xs font-semibold" style="color: var(--text-primary);">{t("baseProxyUrl")}</label>
          <div class="relative flex items-center">
            <input
              class="input-field w-full pl-3 pr-10 py-2.5 text-[0.78rem] font-mono cursor-default select-all"
              type="text"
              value={baseUrl}
              readOnly
              style="color: var(--text-secondary);"
            />
            <CopyButton getText={getBaseUrl} class="absolute right-2" titleKey="copyUrl" />
          </div>
        </div>

        {/* Model selector — matrix or flat fallback */}
        <div class="space-y-1.5">
          <label class="text-xs font-semibold" style="color: var(--text-primary);">{t("defaultModel")}</label>
          {showMatrix ? (
            <div class="rounded-lg overflow-hidden" style="border: 1px solid var(--border);">
              {/* Model family list */}
              <div class="max-h-[200px] overflow-y-auto">
                {modelFamilies.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => handleFamilySelect(f)}
                    class="w-full text-left px-3 py-2 text-[0.78rem] font-medium transition-colors duration-150"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      background: selectedModel === f.id ? "var(--accent-bg)" : "transparent",
                      color: selectedModel === f.id ? "var(--accent)" : "var(--text-primary)",
                    }}
                  >
                    {f.displayName}
                  </button>
                ))}
              </div>
              {/* Reasoning effort buttons */}
              {currentEfforts.length > 1 && (
                <div class="flex gap-1.5 p-2 flex-wrap" style="border-top: 1px solid var(--border); background: var(--bg-input);">
                  {currentEfforts.map((e) => (
                    <button
                      key={e.reasoningEffort}
                      onClick={() => onEffortChange(e.reasoningEffort)}
                      title={e.description}
                      class="px-2.5 py-1 text-[0.7rem] font-semibold rounded transition-all duration-150"
                      style={
                        selectedEffort === e.reasoningEffort
                          ? { background: "var(--accent)", color: "#fff" }
                          : { background: "var(--bg-card)", color: "var(--text-secondary)", border: "1px solid var(--border)" }
                      }
                    >
                      {EFFORT_LABELS[e.reasoningEffort] ?? e.reasoningEffort}
                    </button>
                  ))}
                </div>
              )}
              {/* Speed toggle — Standard / Fast */}
              <div class="flex items-center gap-1.5 p-2" style="border-top: 1px solid var(--border); background: var(--bg-input);">
                <span class="text-[0.68rem] font-medium mr-1" style="color: var(--text-secondary);">{t("speed")}</span>
                <button
                  onClick={() => onSpeedChange(null)}
                  class="px-2.5 py-1 text-[0.7rem] font-semibold rounded transition-all duration-150"
                  style={
                    selectedSpeed === null
                      ? { background: "var(--accent)", color: "#fff" }
                      : { background: "var(--bg-card)", color: "var(--text-secondary)", border: "1px solid var(--border)" }
                  }
                >
                  {t("speedStandard")}
                </button>
                <button
                  onClick={() => onSpeedChange("fast")}
                  class="px-2.5 py-1 text-[0.7rem] font-semibold rounded transition-all duration-150"
                  style={
                    selectedSpeed === "fast"
                      ? { background: "var(--accent)", color: "#fff" }
                      : { background: "var(--bg-card)", color: "var(--text-secondary)", border: "1px solid var(--border)" }
                  }
                >
                  {t("speedFast")}
                </button>
              </div>
            </div>
          ) : (
            <div class="relative">
              <select
                class="input-field w-full appearance-none pl-3 pr-10 py-2.5 text-[0.78rem] font-medium cursor-pointer"
                value={selectedModel}
                onChange={(e) => onModelChange((e.target as HTMLSelectElement).value)}
              >
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2" style="color: var(--text-secondary);">
                <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </div>
            </div>
          )}
        </div>

        {/* API Key */}
        <div class="space-y-1.5 md:col-span-2">
          <label class="text-xs font-semibold" style="color: var(--text-primary);">{t("yourApiKey")}</label>
          <div class="relative flex items-center">
            <div class="absolute left-3" style="color: var(--text-tertiary);">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
              </svg>
            </div>
            <input
              class="input-field w-full pl-10 pr-10 py-2.5 text-[0.78rem] font-mono cursor-default select-all tracking-wider"
              type="text"
              value={apiKey}
              readOnly
              style="color: var(--text-secondary);"
            />
            <CopyButton getText={getApiKey} class="absolute right-2" titleKey="copyApiKey" />
          </div>
          <p class="text-xs mt-1" style="color: var(--text-tertiary);">{t("apiKeyHint")}</p>
        </div>
      </div>
    </div>
  );
}
