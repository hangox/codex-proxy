import { useState, useCallback } from "preact/hooks";

interface AddRelayAccountProps {
  visible: boolean;
  onSubmit: (params: { apiKey: string; baseUrl: string; label: string; format?: string; allowedModels?: string[] }) => Promise<string | null>;
  onCancel: () => void;
}

export function AddRelayAccount({ visible, onSubmit, onCancel }: AddRelayAccountProps) {
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [format, setFormat] = useState("codex");
  const [models, setModels] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = useCallback(async () => {
    setError("");
    if (!label.trim() || !baseUrl.trim() || !apiKey.trim()) {
      setError("Label, Base URL, and API Key are required");
      return;
    }
    setSubmitting(true);
    const allowedModels = models.trim()
      ? models.split(",").map((m) => m.trim()).filter(Boolean)
      : undefined;
    const err = await onSubmit({ apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), label: label.trim(), format, allowedModels });
    setSubmitting(false);
    if (err) {
      setError(err);
    } else {
      setLabel("");
      setBaseUrl("");
      setApiKey("");
      setFormat("codex");
      setModels("");
    }
  }, [label, baseUrl, apiKey, format, models, onSubmit]);

  if (!visible) return null;

  const inputCls = "w-full px-3 py-2 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm transition-colors">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-sm font-semibold text-slate-700 dark:text-text-main">Add Relay Account</h3>
        <button
          onClick={onCancel}
          class="text-slate-400 hover:text-slate-600 dark:hover:text-text-main transition-colors text-sm"
        >
          Cancel
        </button>
      </div>
      {error && <p class="text-sm text-red-500 mb-3">{error}</p>}
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-slate-500 dark:text-text-dim mb-1">Label</label>
            <input type="text" value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} placeholder="My Relay" class={inputCls} />
          </div>
          <div>
            <label class="block text-xs text-slate-500 dark:text-text-dim mb-1">Format</label>
            <select
              value={format}
              onChange={(e) => setFormat((e.target as HTMLSelectElement).value)}
              class={inputCls}
            >
              <option value="codex">Codex</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>
        </div>
        <div>
          <label class="block text-xs text-slate-500 dark:text-text-dim mb-1">Base URL</label>
          <input type="text" value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} placeholder={format === "codex" ? "https://relay.example.com/backend-api" : "https://api.example.com/v1"} class={inputCls} />
        </div>
        <div>
          <label class="block text-xs text-slate-500 dark:text-text-dim mb-1">API Key</label>
          <input type="password" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} placeholder="sk-..." class={inputCls} />
        </div>
        <div>
          <label class="block text-xs text-slate-500 dark:text-text-dim mb-1">Allowed Models <span class="text-slate-400">(optional, comma-separated)</span></label>
          <input type="text" value={models} onInput={(e) => setModels((e.target as HTMLInputElement).value)} placeholder="gpt-5.2-codex, gpt-5.4" class={inputCls} />
        </div>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          class="w-full px-4 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Adding..." : "Add Relay"}
        </button>
      </div>
    </section>
  );
}
