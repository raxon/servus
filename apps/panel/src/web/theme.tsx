import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

type ColorSchemeOverride = "light" | "dark" | null;
type ResolvedScheme = "light" | "dark";

interface ThemeContextValue {
  override: ColorSchemeOverride;
  resolved: ResolvedScheme;
  toggleTheme: () => void;
  setTheme: (scheme: "system" | "light" | "dark") => void;
}

const STORAGE_KEY = "color-scheme";

function getSystemScheme(): ResolvedScheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredOverride(): ColorSchemeOverride {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function applyMetaColorScheme(override: ColorSchemeOverride) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  const content = override ?? "light dark";
  if (meta) {
    meta.content = content;
  } else {
    const created = document.createElement("meta");
    created.name = "color-scheme";
    created.content = content;
    document.head.appendChild(created);
  }
}

const ThemeContext = createContext<ThemeContextValue>({
  override: null,
  resolved: "light",
  toggleTheme: () => {},
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<ColorSchemeOverride>(readStoredOverride);
  const [systemScheme, setSystemScheme] = useState<ResolvedScheme>(getSystemScheme);

  const resolved: ResolvedScheme = override ?? systemScheme;

  useEffect(() => {
    applyMetaColorScheme(override);
  }, [override]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => setSystemScheme(media.matches ? "dark" : "light");
    media.addEventListener("change", onMediaChange);

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setOverride(event.newValue === "light" || event.newValue === "dark" ? event.newValue : null);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onMediaChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setTheme = (scheme: "system" | "light" | "dark") => {
    const next: ColorSchemeOverride = scheme === "system" ? null : scheme;
    setOverride(next);
    applyMetaColorScheme(next);
    try {
      if (next === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore storage access errors */
    }
  };

  // Two-state toggle per modern-web-guidance: target is opposite of rendered scheme;
  // if target matches system preference, clear override so OS changes resume taking effect.
  const toggleTheme = () => {
    const currentSystem = getSystemScheme();
    const target: ResolvedScheme = resolved === "dark" ? "light" : "dark";
    if (target === currentSystem) {
      setTheme("system");
    } else {
      setTheme(target);
    }
  };

  return (
    <ThemeContext.Provider value={{ override, resolved, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function SidebarThemeToggle({ compact = false }: { compact?: boolean }) {
  const { resolved, toggleTheme } = useTheme();
  const isDark = resolved === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  if (compact) {
    return (
      <button
        type="button"
        className="ep-rail-btn"
        onClick={toggleTheme}
        aria-label={label}
        title={label}
      >
        {isDark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="ep-sidebar-utility-btn"
      onClick={toggleTheme}
      aria-pressed={isDark}
      aria-label={label}
    >
      <span className="ep-sidebar-utility-label">
        {isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
        <span>Dark Mode</span>
      </span>
      <span className={`ep-mini-switch ${isDark ? "is-on" : ""}`} aria-hidden="true">
        <span className="ep-mini-switch-thumb" />
      </span>
    </button>
  );
}
