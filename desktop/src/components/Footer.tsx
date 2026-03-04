import { useT } from "../../../shared/i18n/context";

export function Footer() {
  const t = useT();

  return (
    <footer class="mt-auto py-5" style="border-top: 1px solid var(--border);">
      <div class="px-8 lg:px-10 text-center">
        <p class="text-[0.75rem]" style="color: var(--text-tertiary);">{t("footer")}</p>
      </div>
    </footer>
  );
}
