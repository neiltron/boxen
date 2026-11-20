import { useSyncExternalStore } from "react";

// Kept in sync with the inline script in index.html, which applies the stored
// choice before first paint so there is no light flash on load.
const KEY = "pids.theme";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function hasStoredOverride(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark";
  } catch {
    return false;
  }
}

// Follow OS theme changes for the life of the page (main.tsx imports this
// module), unless a stored override pins the theme. The .dark class drives
// Tailwind's dark: variant, the CSS tokens and color-scheme, and useIsDark.
darkQuery.addEventListener("change", (e) => {
  if (!hasStoredOverride()) document.documentElement.classList.toggle("dark", e.matches);
});

function getIsDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function subscribeDark(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDark, getIsDark);
}
