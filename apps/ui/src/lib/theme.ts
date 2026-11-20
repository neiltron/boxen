import { useEffect, useSyncExternalStore } from "react";

// Kept in sync with the inline script in index.html, which applies the stored
// choice before first paint so there is no light flash on load.
const KEY = "pids.theme";

export type Theme = "light" | "dark" | "system";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function readStored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function writeStored(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be blocked; still apply the theme to the page.
  }
}

let currentTheme: Theme = readStored();
const themeListeners = new Set<() => void>();

// Updating <meta name="color-scheme"> drives :root color-scheme (and
// light-dark() tokens) via index.css; .dark stays in sync for Tailwind's
// dark: variant, shadcn tokens, and JS consumers (Pierre, Ghostty, Mermaid).
function apply(theme: Theme) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.content = theme === "system" ? "light dark" : theme;
  const isDark = theme === "dark" || (theme === "system" && darkQuery.matches);
  document.documentElement.classList.toggle("dark", isDark);
}

function notifyTheme() {
  for (const listener of themeListeners) listener();
}

function setTheme(next: Theme) {
  writeStored(next);
  currentTheme = next;
  apply(next);
  notifyTheme();
}

function onSystemChange() {
  // Only follow system changes when no explicit override is active; never
  // clear a stored override if the OS later happens to match it.
  if (currentTheme === "system") apply("system");
}

function onStorage(e: StorageEvent) {
  if (e.key !== null && e.key !== KEY) return;
  currentTheme = readStored();
  apply(currentTheme);
  notifyTheme();
}

let syncRefCount = 0;
function retainSync() {
  if (syncRefCount++ === 0) {
    darkQuery.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
  }
  return () => {
    if (--syncRefCount === 0) {
      darkQuery.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    }
  };
}

function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  const release = retainSync();
  return () => {
    themeListeners.delete(listener);
    release();
  };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, () => currentTheme);

  useEffect(() => {
    apply(theme);
  }, [theme]);

  return { theme, setTheme };
}

export function getResolvedDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function subscribeDark(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const release = retainSync();
  return () => {
    observer.disconnect();
    release();
  };
}

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDark, getResolvedDark);
}
