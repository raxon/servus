import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Globe, Palette } from "lucide-react";
import { DEFAULT_BRANDING, type PlatformBrandingSettings, type SupportedLocale } from "../shared/platform-settings.js";
import { api, errorMessage } from "./api.js";
import { LocaleSwitcher, useI18n } from "./i18n.js";

export function PlatformSettings() {
  const client = useQueryClient();
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["platform-branding"],
    queryFn: ({ signal }) => api<PlatformBrandingSettings>("/platform/branding", { signal }),
  });

  const [draft, setDraft] = useState<PlatformBrandingSettings>(DEFAULT_BRANDING);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      api<PlatformBrandingSettings>("/settings/branding", {
        method: "PUT",
        body: {
          brandName: draft.brandName,
          accentColor: draft.accentColor,
          logoUrl: draft.logoUrl || null,
          defaultLocale: draft.defaultLocale,
          maintenanceMode: draft.maintenanceMode,
          maintenanceTitle: draft.maintenanceTitle,
          maintenanceMessage: draft.maintenanceMessage,
          customErrorTitle: draft.customErrorTitle,
          customErrorMessage: draft.customErrorMessage,
        },
      }),
    onSuccess: (updated) => {
      setSaved(true);
      client.setQueryData(["platform-branding"], updated);
    },
  });

  return (
    <section className="surface details-card" id="platform-branding" aria-label="Branding, language and status pages">
      <div className="settings-card-header">
        <div className="settings-card-intro">
          <div className="card-heading">
            <Palette size={19} aria-hidden="true" />
            <h3>{t("settings.branding", "Branding, language & status pages")}</h3>
          </div>
          <p>Customize instance branding, default UI language (EN/PL), and maintenance or custom error pages.</p>
        </div>
        <LocaleSwitcher />
      </div>

      <form
        style={{ display: "grid", gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <div className="form-grid">
          <label>
            Panel brand name
            <input value={draft.brandName} maxLength={60} required onChange={(e) => setDraft({ ...draft, brandName: e.target.value })} />
          </label>
          <label>
            Accent color
            <input type="color" value={draft.accentColor} onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })} />
          </label>
        </div>

        <div className="form-grid">
          <label>
            Logo URL (optional https://)
            <input
              type="url"
              value={draft.logoUrl ?? ""}
              placeholder="https://example.com/logo.svg"
              onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value || null })}
            />
          </label>
          <label>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Globe size={14} aria-hidden="true" /> Default language</span>
            <select value={draft.defaultLocale} onChange={(e) => setDraft({ ...draft, defaultLocale: e.target.value as SupportedLocale })}>
              <option value="en">English (EN)</option>
              <option value="pl">Polski (PL)</option>
            </select>
          </label>
        </div>

        <label className="checkbox-label">
          <input type="checkbox" checked={draft.maintenanceMode} onChange={(e) => setDraft({ ...draft, maintenanceMode: e.target.checked })} />
          Global maintenance notice flag
        </label>

        <div className="form-grid">
          <label>
            Maintenance page title
            <input value={draft.maintenanceTitle} maxLength={120} required onChange={(e) => setDraft({ ...draft, maintenanceTitle: e.target.value })} />
          </label>
          <label>
            Error page title
            <input value={draft.customErrorTitle} maxLength={120} required onChange={(e) => setDraft({ ...draft, customErrorTitle: e.target.value })} />
          </label>
        </div>

        <div className="form-grid">
          <label>
            Maintenance message
            <textarea rows={2} value={draft.maintenanceMessage} maxLength={1000} required onChange={(e) => setDraft({ ...draft, maintenanceMessage: e.target.value })} />
          </label>
          <label>
            Custom error message
            <textarea rows={2} value={draft.customErrorMessage} maxLength={1000} required onChange={(e) => setDraft({ ...draft, customErrorMessage: e.target.value })} />
          </label>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            {save.isPending ? "Saving..." : t("common.save", "Save")}
          </button>
          <a href="/api/v1/platform/status-page?mode=maintenance" target="_blank" rel="noreferrer" className="button button-small">
            Preview maintenance page <ArrowUpRight size={13} aria-hidden="true" />
          </a>
          <a href="/api/v1/platform/status-page?mode=error" target="_blank" rel="noreferrer" className="button button-small">
            Preview error page <ArrowUpRight size={13} aria-hidden="true" />
          </a>
          {saved ? <span role="status" className="mono">Saved</span> : null}
        </div>
        {save.error ? <div className="error-notice" role="alert">{errorMessage(save.error)}</div> : null}
      </form>
    </section>
  );
}
