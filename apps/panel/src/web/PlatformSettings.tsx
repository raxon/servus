import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Globe, Palette } from "lucide-react";
import { DEFAULT_BRANDING, type PlatformBrandingSettings, type SupportedLocale } from "../shared/platform-settings.js";
import { api, errorMessage } from "./api.js";
import { LocaleSwitcher, useI18n } from "./i18n.js";

export function PlatformSettings() {
  const id = useId();
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
    <section className="settings-group" id="platform-branding" aria-labelledby="settings-branding-heading">
      <h2 id="settings-branding-heading">Branding &amp; localization</h2>

      <section className="surface details-card" aria-label="Branding, language and status pages">
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
          className="module-card-fields"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <div className="servus-grid-2">
            <div className="servus-field">
              <label htmlFor={`${id}-brand-name`}>Panel brand name</label>
              <input
                id={`${id}-brand-name`}
                className="servus-input"
                value={draft.brandName}
                maxLength={60}
                required
                onChange={(e) => setDraft({ ...draft, brandName: e.target.value })}
              />
            </div>

            <div className="servus-field">
              <label htmlFor={`${id}-accent-hex`}>Accent color</label>
              <div className="servus-color-row">
                <input
                  type="color"
                  className="servus-color-swatch"
                  aria-label="Accent color picker"
                  value={draft.accentColor}
                  onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
                />
                <input
                  id={`${id}-accent-hex`}
                  className="servus-input mono"
                  value={draft.accentColor}
                  maxLength={7}
                  pattern="^#[0-9a-fA-F]{6}$"
                  onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div className="servus-grid-2">
            <div className="servus-field">
              <label htmlFor={`${id}-logo-url`}>Logo URL (optional https://)</label>
              <input
                id={`${id}-logo-url`}
                className="servus-input"
                type="url"
                value={draft.logoUrl ?? ""}
                placeholder="https://example.com/logo.svg"
                onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value || null })}
              />
            </div>

            <div className="servus-field">
              <label htmlFor={`${id}-locale`}>
                <Globe size={14} aria-hidden="true" />
                Default language
              </label>
              <select
                id={`${id}-locale`}
                className="servus-select"
                value={draft.defaultLocale}
                onChange={(e) => setDraft({ ...draft, defaultLocale: e.target.value as SupportedLocale })}
              >
                <option value="en">English (EN)</option>
                <option value="pl">Polski (PL)</option>
              </select>
            </div>
          </div>

          <label className="servus-toggle-row" htmlFor={`${id}-maint-flag`}>
            <span>
              <strong>Global maintenance notice flag</strong>
              <small>Marks the platform as under scheduled maintenance for status pages and clients.</small>
            </span>
            <input
              id={`${id}-maint-flag`}
              type="checkbox"
              checked={draft.maintenanceMode}
              onChange={(e) => setDraft({ ...draft, maintenanceMode: e.target.checked })}
            />
          </label>

          <div className="servus-grid-2">
            <div className="servus-field">
              <label htmlFor={`${id}-maint-title`}>Maintenance page title</label>
              <input
                id={`${id}-maint-title`}
                className="servus-input"
                value={draft.maintenanceTitle}
                maxLength={120}
                required
                onChange={(e) => setDraft({ ...draft, maintenanceTitle: e.target.value })}
              />
            </div>
            <div className="servus-field">
              <label htmlFor={`${id}-err-title`}>Error page title</label>
              <input
                id={`${id}-err-title`}
                className="servus-input"
                value={draft.customErrorTitle}
                maxLength={120}
                required
                onChange={(e) => setDraft({ ...draft, customErrorTitle: e.target.value })}
              />
            </div>
          </div>

          <div className="servus-grid-2">
            <div className="servus-field">
              <label htmlFor={`${id}-maint-msg`}>Maintenance message</label>
              <textarea
                id={`${id}-maint-msg`}
                className="servus-textarea"
                rows={3}
                value={draft.maintenanceMessage}
                maxLength={1000}
                required
                onChange={(e) => setDraft({ ...draft, maintenanceMessage: e.target.value })}
              />
            </div>
            <div className="servus-field">
              <label htmlFor={`${id}-err-msg`}>Custom error message</label>
              <textarea
                id={`${id}-err-msg`}
                className="servus-textarea"
                rows={3}
                value={draft.customErrorMessage}
                maxLength={1000}
                required
                onChange={(e) => setDraft({ ...draft, customErrorMessage: e.target.value })}
              />
            </div>
          </div>

          <div className="servus-inline-row" style={{ paddingTop: 4 }}>
            <button type="submit" className="button button-primary" disabled={save.isPending}>
              {save.isPending ? "Saving..." : t("common.save", "Save")}
            </button>
            <a href="/api/v1/platform/status-page?mode=maintenance" target="_blank" rel="noreferrer" className="button button-small">
              Preview maintenance page <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            <a href="/api/v1/platform/status-page?mode=error" target="_blank" rel="noreferrer" className="button button-small">
              Preview error page <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            {saved ? <span role="status" className="servus-help mono">Saved</span> : null}
          </div>
          {save.error ? <div className="error-notice" role="alert" style={{ margin: 0 }}>{errorMessage(save.error)}</div> : null}
        </form>
      </section>
    </section>
  );
}
