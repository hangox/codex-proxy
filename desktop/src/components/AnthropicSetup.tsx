import { useMemo, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { CopyButton } from "./CopyButton";

interface AnthropicSetupProps {
  apiKey: string;
  selectedModel: string;
  reasoningEffort: string;
  serviceTier: string | null;
}

export function AnthropicSetup({ apiKey, selectedModel, reasoningEffort, serviceTier }: AnthropicSetupProps) {
  const t = useT();

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8080";

  // Build compound model name with suffixes
  const displayModel = useMemo(() => {
    let name = selectedModel;
    if (reasoningEffort && reasoningEffort !== "medium") name += `-${reasoningEffort}`;
    if (serviceTier === "fast") name += "-fast";
    return name;
  }, [selectedModel, reasoningEffort, serviceTier]);

  const envLines = useMemo(() => ({
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: displayModel,
  }), [origin, apiKey, displayModel]);

  const allEnvText = useMemo(
    () => Object.entries(envLines).map(([k, v]) => `${k}=${v}`).join("\n"),
    [envLines],
  );

  const getAllEnv = useCallback(() => allEnvText, [allEnvText]);
  const getBaseUrl = useCallback(() => envLines.ANTHROPIC_BASE_URL, [envLines]);
  const getApiKey = useCallback(() => envLines.ANTHROPIC_API_KEY, [envLines]);
  const getModel = useCallback(() => envLines.ANTHROPIC_MODEL, [envLines]);

  return (
    <div class="card p-6">
      <div class="flex items-center gap-2 mb-6 pb-4" style="border-bottom: 1px solid var(--border);">
        <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
        </svg>
        <h2 class="text-[0.95rem] font-semibold" style="color: var(--text-primary);">{t("anthropicSetup")}</h2>
      </div>

      <div class="space-y-3">
        {(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"] as const).map((key) => {
          const getter = key === "ANTHROPIC_BASE_URL" ? getBaseUrl : key === "ANTHROPIC_API_KEY" ? getApiKey : getModel;
          return (
            <div key={key} class="flex items-center gap-3">
              <label class="text-xs font-mono font-semibold w-44 shrink-0" style="color: var(--text-secondary);">{key}</label>
              <div class="relative flex items-center flex-1">
                <input
                  class="input-field w-full pl-3 pr-10 py-2 text-[0.78rem] font-mono cursor-default select-all"
                  type="text"
                  value={envLines[key]}
                  readOnly
                  style="color: var(--text-secondary);"
                />
                <CopyButton getText={getter} class="absolute right-2" />
              </div>
            </div>
          );
        })}
      </div>

      <div class="mt-5 flex items-center gap-3">
        <CopyButton getText={getAllEnv} variant="label" />
        <span class="text-xs" style="color: var(--text-tertiary);">{t("anthropicCopyAllHint")}</span>
      </div>
    </div>
  );
}
