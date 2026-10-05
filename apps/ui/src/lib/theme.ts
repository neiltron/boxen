import { useEffect, useState } from "react";

// Kept in sync with the inline script in index.html, which applies the stored
// choice before first paint so there is no light flash on load.
const KEY = "pids.theme";

export type Theme = "light" | "dark" | "system";

const dark = window.matchMedia("(prefers-color-scheme: dark)");

function stored(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

// `color-scheme` on <html> is what makes native scrollbars and form controls
// follow along; the .dark class is what the shadcn tokens key off.
function apply(theme: Theme) {
  const isDark = theme === "dark" || (theme === "system" && dark.matches);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

export function useTheme() {
  const [theme, setTheme] = useState(stored);

  useEffect(() => {
    apply(theme);
    if (theme !== "system") return;
    const onChange = () => apply("system");
    dark.addEventListener("change", onChange);
    return () => dark.removeEventListener("change", onChange);
  }, [theme]);

  return {
    theme,
    setTheme: (next: Theme) => {
      localStorage.setItem(KEY, next);
      setTheme(next);
    },
  };
}
