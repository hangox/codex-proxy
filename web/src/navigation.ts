import type { TranslationKey } from "../../shared/i18n/translations";

export const NAV_ITEMS: Array<{ hash: string; label: TranslationKey }> = [
  { hash: "", label: "overview" },
  { hash: "#/accounts", label: "manageAccounts" },
  { hash: "#/client-keys", label: "clientKeys" },
  { hash: "#/api-keys", label: "apiKeys" },
  { hash: "#/proxies", label: "proxySettings" },
  { hash: "#/usage-stats", label: "usageStats" },
  { hash: "#/logs", label: "logs" },
  { hash: "#/errors", label: "errorsTab" },
  { hash: "#/settings", label: "settings" },
];
