export type LayoutMode = "sidebar" | "top";

const LAYOUT_MODE_KEY = "codex-proxy-layout-mode";

export function getLayoutMode(): LayoutMode {
  try {
    return localStorage.getItem(LAYOUT_MODE_KEY) === "top" ? "top" : "sidebar";
  } catch {
    return "sidebar";
  }
}

export function saveLayoutMode(mode: LayoutMode): void {
  try {
    localStorage.setItem(LAYOUT_MODE_KEY, mode);
  } catch {
  }
}
