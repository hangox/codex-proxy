import { useT } from "../../../shared/i18n/context";
import type { UpdateStatus } from "../../../shared/hooks/use-update-status";

interface FooterProps {
  updateStatus: UpdateStatus | null;
}

export function Footer({ updateStatus }: FooterProps) {
  const t = useT();

  const proxyVersion = updateStatus?.proxy.version ?? "...";
  const proxyCommit = updateStatus?.proxy.commit;
  const codexVersion = updateStatus?.codex.current_version;

  return (
    <footer class="mt-auto py-5" style="border-top: 1px solid var(--border);">
      <div class="px-8 lg:px-10 flex flex-col items-center gap-1.5">
        <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[0.7rem] font-mono" style="color: var(--text-tertiary);">
          <span>Proxy v{proxyVersion}{proxyCommit ? ` (${proxyCommit})` : ""}</span>
          {codexVersion && (
            <>
              <span style="color: var(--border);">&middot;</span>
              <span>Codex Desktop v{codexVersion}</span>
            </>
          )}
        </div>
        <p class="text-[0.75rem]" style="color: var(--text-tertiary);">{t("footer")}</p>
      </div>
    </footer>
  );
}
