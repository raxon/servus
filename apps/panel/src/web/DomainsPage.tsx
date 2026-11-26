import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink, Globe2, Pencil, Search, Star } from "lucide-react";
import type { Project, RuntimeStatus, Service } from "../shared/types.js";
import { api } from "./api.js";
import { applicationUrl } from "./application-url.js";

export function DomainsPage({
  projects,
  runtime,
}: {
  projects: Project[];
  runtime: RuntimeStatus | undefined;
}) {
  const [search, setSearch] = useState("");

  const serviceQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["services", project.id],
      queryFn: () => api<Service[]>(`/projects/${project.id}/services`),
      refetchInterval: 5_000,
    })),
  });

  const entries = useMemo(() => {
    const list: Array<{
      id: string;
      project: Project;
      service: Service;
      hostname: string;
      port: number;
      primary: boolean;
      url: string | null;
    }> = [];

    projects.forEach((project, idx) => {
      const raw = serviceQueries[idx]?.data;
      const services = Array.isArray(raw) ? raw : [];
      for (const service of services) {
        if (service.kind && service.kind !== "app") continue;
        const domains = service.domains?.length
          ? service.domains
          : service.hostname
            ? [{ hostname: service.hostname, port: service.port, primary: true }]
            : [];
        for (const domain of domains) {
          list.push({
            id: `${service.id}:${domain.hostname}:${domain.port}`,
            project,
            service,
            hostname: domain.hostname,
            port: domain.port,
            primary: domain.primary === true,
            url: applicationUrl(domain, runtime?.ingressPort ?? 18080),
          });
        }
      }
    });

    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((entry) =>
      `${entry.hostname} ${entry.project.name} ${entry.service.name}`.toLowerCase().includes(needle),
    );
  }, [projects, serviceQueries, runtime?.ingressPort, search]);

  return (
    <div className="ep-page">
      <header className="ep-page-header">
        <h1>Domains</h1>
        <div className="ep-page-header-actions">
          <div className="ep-search-inline">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              placeholder="Filter domains..."
              aria-label="Filter domains"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Link to="/settings" hash="connectivity" className="button button-small">
            HTTPS &amp; Host Domain
          </Link>
        </div>
      </header>

      <div className="ep-framed-card">
        <div className="ep-framed-head">
          <span>Domains ({entries.length})</span>
        </div>
        <div className="ep-framed-body">
          {entries.length ? (
            <div className="ep-domain-list">
              {entries.map((entry) => (
                <div key={entry.id} className="ep-domain-row">
                  <div className="ep-domain-source mono">
                    {entry.url ?? `http://${entry.hostname}/`}
                  </div>
                  <ArrowRight size={14} className="ep-domain-arrow" aria-hidden="true" />
                  <div className="ep-domain-target mono">
                    http://{entry.project.name}_{entry.service.name}:{entry.port}/
                  </div>
                  <div className="ep-domain-actions">
                    {entry.primary ? (
                      <span className="ep-icon-pill is-star" title="Primary domain" aria-label="Primary domain">
                        <Star size={14} fill="currentColor" aria-hidden="true" />
                      </span>
                    ) : null}
                    {entry.url ? (
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ep-icon-pill"
                        title={`Open ${entry.hostname}`}
                        aria-label={`Open ${entry.hostname}`}
                      >
                        <ExternalLink size={14} aria-hidden="true" />
                      </a>
                    ) : null}
                    <Link
                      to="/services/$serviceId"
                      params={{ serviceId: entry.service.id }}
                      search={{ tab: "domains" }}
                      className="ep-icon-pill"
                      title={`Manage domains for ${entry.service.name}`}
                      aria-label={`Manage domains for ${entry.service.name}`}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="ep-empty-inline">
              <Globe2 size={20} aria-hidden="true" />
              <span>
                {search
                  ? "No domains match your filter."
                  : "No application domains configured yet. Create an application service to get an automatic Servus host domain."}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
