import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";

interface AddAccountProps {
  visible: boolean;
  onSubmitRelay: (callbackUrl: string) => Promise<void>;
  addInfo: string;
  addError: string;
}

export function AddAccount({ visible, onSubmitRelay, addInfo, addError }: AddAccountProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    await onSubmitRelay(input);
    setSubmitting(false);
    setInput("");
  }, [input, onSubmitRelay]);

  if (!visible && !addInfo && !addError) return null;

  return (
    <>
      {addInfo && (
        <p class="text-sm text-primary font-medium">{t(addInfo as TranslationKey)}</p>
      )}
      {addError && (
        <p class="text-sm text-red-500 font-medium">{t(addError as TranslationKey)}</p>
      )}
      {visible && (
        <div class="card p-6">
          <ol class="text-sm mb-5 space-y-2 list-decimal list-inside" style="color: var(--text-secondary);">
            <li dangerouslySetInnerHTML={{ __html: t("addStep1") }} />
            <li dangerouslySetInnerHTML={{ __html: t("addStep2") }} />
            <li dangerouslySetInnerHTML={{ __html: t("addStep3") }} />
          </ol>
          <div class="flex gap-3">
            <input
              type="text"
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              placeholder={t("pasteCallback")}
              class="input-field flex-1 px-3 py-2.5 text-sm font-mono"
            />
            <button
              onClick={handleSubmit}
              disabled={submitting}
              class="px-5 py-2.5 text-sm font-medium rounded-[var(--radius-button)] transition-colors duration-150 disabled:opacity-50"
              style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text-primary);"
            >
              {submitting ? t("submitting") : t("submit")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
