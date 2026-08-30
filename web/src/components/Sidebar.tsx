import { useI18n, useT } from "../../../shared/i18n/context";
import { NAV_ITEMS } from "../navigation";

type IconName = "home" | "users" | "key" | "api" | "route" | "chart" | "document" | "alert" | "settings";

const ICONS: Record<IconName, string> = {
  home: "M3 10.5 12 3l9 7.5M5.25 9v10.5h13.5V9M9 19.5v-6h6v6",
  users: "M16.5 19.5v-1.125a3.375 3.375 0 0 0-3.375-3.375h-6.75A3.375 3.375 0 0 0 3 18.375V19.5M9.75 11.25a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5ZM16.5 8.25a3 3 0 0 1 0 5.82M21 19.5v-1.125a3.375 3.375 0 0 0-2.25-3.182",
  key: "M15.75 5.25a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 19.5v-1.125a3.375 3.375 0 0 1 3.375-3.375h6.75A3.375 3.375 0 0 1 18 18.375V19.5M19.5 8.25l1.5 1.5-4.5 4.5-1.5-1.5 4.5-4.5Z",
  api: "M8.25 3.75h7.5M8.25 20.25h7.5M6 6.75h12v10.5H6zM9 9.75h6M9 14.25h3",
  route: "M4.5 6.75h6M13.5 6.75h6M4.5 17.25h6M13.5 17.25h6M10.5 6.75a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0ZM16.5 17.25a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0ZM12 8.25v7.5",
  chart: "M4.5 19.5V9.75M9.75 19.5V4.5M15 19.5v-6.75M20.25 19.5H3.75",
  document: "M6.75 3.75h7.5l3 3v13.5H6.75zM14.25 3.75v3h3M9.75 11.25h4.5M9.75 15h4.5",
  alert: "M12 9v3.75m0 3h.008v.008H12V15.75ZM10.29 3.86 2.82 17.11a1.875 1.875 0 0 0 1.63 2.81h15.1a1.875 1.875 0 0 0 1.63-2.81L13.71 3.86a1.95 1.95 0 0 0-3.42 0Z",
  settings: "M9.594 3.94a1.125 1.125 0 0 1 1.11-.94h2.592a1.125 1.125 0 0 1 1.11.94l.213 1.281c.063.374.313.686.645.87l.22.127c.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992v.255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124l-.22.128c-.331.183-.581.495-.644.869l-.213 1.281a1.125 1.125 0 0 1-1.11.941h-2.594a1.125 1.125 0 0 1-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87l-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991v-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124l.22-.128c.332-.183.582-.495.644-.869l.214-1.28ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
};

const ICON_NAMES: IconName[] = ["home", "users", "key", "api", "route", "chart", "document", "alert", "settings"];

function NavIcon({ name }: { name: IconName }) {
  return (
    <svg class="size-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

function BrandMark() {
  return (
    <div class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-action text-white shadow-sm shadow-primary/20">
      <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
        <path d="m12 2.75 7.5 4.3v9.9L12 21.25l-7.5-4.3v-9.9L12 2.75Z" />
        <path d="m8.5 9.25 3.5 2 3.5-2M8.5 14.75l3.5-2 3.5 2M12 11.25v4" />
      </svg>
    </div>
  );
}

function NavigationLinks({ activeHash, unreadErrors = 0, mobile = false }: { activeHash: string; unreadErrors?: number; mobile?: boolean }) {
  const t = useT();
  return (
    <>
      {NAV_ITEMS.map((item, index) => {
        const isActive = activeHash === item.hash;
        return (
          <a
            key={item.hash}
            href={item.hash || "#/"}
            class={`${mobile ? "shrink-0 px-3" : "w-full px-4"} flex items-center gap-3 rounded-xl py-2.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-primary/15 text-primary shadow-sm"
                : "text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark/60 hover:text-slate-800 dark:hover:text-text-main"
            }`}
          >
            <NavIcon name={ICON_NAMES[index]} />
            <span class={mobile ? "whitespace-nowrap" : "truncate"}>{t(item.label)}</span>
            {item.hash === "#/errors" && unreadErrors > 0 && (
              <span class="ml-auto rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white">{unreadErrors > 99 ? "99+" : unreadErrors}</span>
            )}
          </a>
        );
      })}
    </>
  );
}

export function Sidebar({ activeHash, unreadErrors = 0 }: { activeHash: string; unreadErrors?: number }) {
  const { t } = useI18n();
  return (
    <aside class="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-gray-200 bg-white dark:border-border-dark dark:bg-card-dark lg:flex">
      <div class="flex h-20 shrink-0 items-center gap-3 border-b border-gray-100 px-7 dark:border-border-dark">
        <BrandMark />
        <div>
          <div class="text-[1.05rem] font-bold tracking-tight text-slate-800 dark:text-text-main">Codex Proxy</div>
          <div class="mt-0.5 text-[0.65rem] font-medium uppercase tracking-[0.16em] text-slate-400 dark:text-text-dim">Dashboard</div>
        </div>
      </div>
      <nav class="flex-1 space-y-1 overflow-y-auto px-4 py-6" aria-label="Primary navigation">
        <NavigationLinks activeHash={activeHash} unreadErrors={unreadErrors} />
      </nav>
      <div class="m-4 rounded-xl border border-primary/15 bg-primary/5 p-4 dark:bg-primary/10">
        <div class="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-text-main">
          <span class="relative flex size-2.5"><span class="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" /><span class="relative inline-flex size-2.5 rounded-full bg-primary" /></span>
          {t("serverOnline")}
        </div>
        <p class="mt-2 text-[0.7rem] leading-5 text-slate-500 dark:text-text-dim">{t("sidebarStatusHint")}</p>
      </div>
    </aside>
  );
}

export function MobileNavigation({ activeHash, unreadErrors = 0 }: { activeHash: string; unreadErrors?: number }) {
  return (
    <nav class="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-gray-200 bg-white px-4 py-2 dark:border-border-dark dark:bg-card-dark lg:hidden" aria-label="Primary navigation">
      <NavigationLinks activeHash={activeHash} unreadErrors={unreadErrors} mobile />
    </nav>
  );
}
