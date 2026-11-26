import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_BRANDING, type PlatformBrandingSettings, type SupportedLocale } from "../shared/platform-settings.js";
import { api } from "./api.js";

const DICTIONARY: Record<SupportedLocale, Record<string, string>> = {
  en: {
    "nav.overview": "Overview",
    "nav.projects": "Projects",
    "nav.settings": "Settings",
    "nav.signOut": "Sign out",
    "settings.branding": "Branding, language & status pages",
    "settings.hostAdmin": "Host administration",
    "settings.backups": "Backups",
    "project.export": "Export project",
    "project.import": "Import project",
    "modules.wordpress": "Managed WordPress",
    "modules.box": "Sandbox Box",
    "common.save": "Save",
    "common.cancel": "Cancel",
  },
  pl: {
    "nav.overview": "Przeglad",
    "nav.projects": "Projekty",
    "nav.settings": "Ustawienia",
    "nav.signOut": "Wyloguj",
    "settings.branding": "Branding, jezyk i strony bledow",
    "settings.hostAdmin": "Administracja hostem",
    "settings.backups": "Kopie zapasowe",
    "project.export": "Eksportuj projekt",
    "project.import": "Importuj projekt",
    "modules.wordpress": "Zarzadzany WordPress",
    "modules.box": "Srodowisko Box",
    "common.save": "Zapisz",
    "common.cancel": "Anuluj",
  },
};

interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: string, fallback?: string) => string;
  branding: PlatformBrandingSettings;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  setLocale: () => {},
  t: (key, fallback) => fallback ?? DICTIONARY.en[key] ?? key,
  branding: DEFAULT_BRANDING,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    try {
      const saved = window.localStorage.getItem("servus.locale");
      if (saved === "pl" || saved === "en") return saved;
    } catch { /* ignore */ }
    return "en";
  });

  const brandingQuery = useQuery({
    queryKey: ["platform-branding"],
    queryFn: ({ signal }) => api<PlatformBrandingSettings>("/platform/branding", { signal }),
    staleTime: 60_000,
    retry: false,
  });

  const branding = brandingQuery.data ?? DEFAULT_BRANDING;

  useEffect(() => {
    if (!brandingQuery.data) return;
    try {
      const explicit = window.localStorage.getItem("servus.locale");
      if (!explicit && (brandingQuery.data.defaultLocale === "pl" || brandingQuery.data.defaultLocale === "en")) {
        setLocaleState(brandingQuery.data.defaultLocale);
      }
    } catch { /* ignore */ }
    if (brandingQuery.data.brandName) {
      document.title = brandingQuery.data.brandName;
    }
    if (brandingQuery.data.accentColor) {
      document.documentElement.style.setProperty("--accent", brandingQuery.data.accentColor);
    }
  }, [brandingQuery.data]);

  const setLocale = (next: SupportedLocale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem("servus.locale", next);
    } catch { /* ignore */ }
  };

  const t = (key: string, fallback?: string) => DICTIONARY[locale]?.[key] ?? DICTIONARY.en[key] ?? fallback ?? key;

  return <I18nContext.Provider value={{ locale, setLocale, t, branding }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function LocaleSwitcher() {
  const { locale, setLocale } = useI18n();
  return (
    <div role="group" aria-label="Language" style={{ display: "inline-flex", gap: 4 }}>
      <button
        type="button"
        className={`button button-small${locale === "en" ? " button-primary" : ""}`}
        onClick={() => setLocale("en")}
      >
        EN
      </button>
      <button
        type="button"
        className={`button button-small${locale === "pl" ? " button-primary" : ""}`}
        onClick={() => setLocale("pl")}
      >
        PL
      </button>
    </div>
  );
}
