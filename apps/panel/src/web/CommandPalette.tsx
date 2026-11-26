import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  Box,
  Database,
  Folder,
  Globe2,
  Home,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Zap,
} from "lucide-react";
import type { Project, Service } from "../shared/types.js";
import { api } from "./api.js";
import { useTheme } from "./theme.js";

interface PaletteItem {
  id: string;
  group: "Pages" | "Projects" | "Services" | "Actions";
  label: string;
  hint?: string;
  icon: "home" | "actions" | "monitor" | "domains" | "settings" | "project" | "app" | "db" | "redis" | "theme" | "plus";
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  projects,
  canCreateProject,
  onCreateProject,
}: {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  canCreateProject: boolean;
  onCreateProject: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { resolved, toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const serviceQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["services", project.id],
      queryFn: () => api<Service[]>(`/projects/${project.id}/services`),
      enabled: open,
      staleTime: 10_000,
    })),
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Fallback click-outside dismissal for browsers without native closedby="any"
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open || "closedBy" in HTMLDialogElement.prototype) return;
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    const onDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) onClose();
    };
    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, [open, onClose]);

  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [
      { id: "page-dashboard", group: "Pages", label: "Dashboard", hint: "Overview of projects & server telemetry", icon: "home", run: () => void navigate({ to: "/" }) },
      { id: "page-actions", group: "Pages", label: "Actions", hint: "Recent deployments and operations", icon: "actions", run: () => void navigate({ to: "/activity" }) },
      { id: "page-monitor", group: "Pages", label: "Monitor", hint: "Server telemetry, Docker events & storage", icon: "monitor", run: () => void navigate({ to: "/monitor" }) },
      { id: "page-domains", group: "Pages", label: "Domains", hint: "All configured routes across projects", icon: "domains", run: () => void navigate({ to: "/domains" }) },
      { id: "page-settings", group: "Pages", label: "Settings", hint: "Instance, backups, security & branding", icon: "settings", run: () => void navigate({ to: "/settings" }) },
    ];

    for (const project of projects) {
      all.push({
        id: `project-${project.id}`,
        group: "Projects",
        label: project.name,
        hint: "Open project",
        icon: "project",
        run: () => void navigate({ to: "/projects/$projectId", params: { projectId: project.id } }),
      });
    }

    projects.forEach((project, idx) => {
      const raw = serviceQueries[idx]?.data;
      const services = Array.isArray(raw) ? raw : [];
      for (const service of services) {
        all.push({
          id: `service-${service.id}`,
          group: "Services",
          label: `${project.name} / ${service.name}`,
          hint: `${service.kind ?? "app"} · ${service.state}`,
          icon: service.kind === "redis" ? "redis" : service.kind && service.kind !== "app" ? "db" : "app",
          run: () => void navigate({ to: "/services/$serviceId", params: { serviceId: service.id } }),
        });
      }
    });

    if (canCreateProject) {
      all.push({
        id: "action-new-project",
        group: "Actions",
        label: "Create new project",
        hint: "Add a new project workspace",
        icon: "plus",
        run: onCreateProject,
      });
    }
    all.push({
      id: "action-theme",
      group: "Actions",
      label: resolved === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode",
      hint: "Change appearance theme",
      icon: "theme",
      run: toggleTheme,
    });

    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((item) =>
      `${item.label} ${item.hint ?? ""} ${item.group}`.toLowerCase().includes(needle),
    );
  }, [projects, serviceQueries, query, navigate, canCreateProject, onCreateProject, resolved, toggleTheme]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const executeItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const renderIcon = (kind: PaletteItem["icon"]) => {
    switch (kind) {
      case "home": return <Home size={15} aria-hidden="true" />;
      case "actions": return <Activity size={15} aria-hidden="true" />;
      case "monitor": return <BarChart3 size={15} aria-hidden="true" />;
      case "domains": return <Globe2 size={15} aria-hidden="true" />;
      case "settings": return <Settings size={15} aria-hidden="true" />;
      case "project": return <Folder size={15} aria-hidden="true" />;
      case "db": return <Database size={15} aria-hidden="true" />;
      case "redis": return <Zap size={15} aria-hidden="true" />;
      case "plus": return <Plus size={15} aria-hidden="true" />;
      case "theme": return resolved === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />;
      default: return <Box size={15} aria-hidden="true" />;
    }
  };

  const groups = ["Projects", "Services", "Pages", "Actions"] as const;

  return (
    <dialog
      ref={dialogRef}
      className="ep-cmd-dialog"
      aria-label="Quick search"
      onClose={onClose}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      {open ? (
        <div className="ep-cmd-surface">
          <div className="ep-cmd-input-row">
            <Search size={16} aria-hidden="true" className="ep-cmd-search-icon" />
            <input
              ref={inputRef}
              type="search"
              className="ep-cmd-input"
              placeholder="Search projects, services, pages..."
              aria-label="Search projects, services, and pages"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedIndex((idx) => (items.length ? (idx + 1) % items.length : 0));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedIndex((idx) => (items.length ? (idx - 1 + items.length) % items.length : 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  executeItem(items[selectedIndex]);
                }
              }}
            />
            <kbd className="ep-kbd">ESC</kbd>
          </div>

          <div className="ep-cmd-list" role="listbox" aria-label="Search results">
            {items.length === 0 ? (
              <div className="ep-cmd-empty">No matching projects, services, or commands.</div>
            ) : (
              groups.map((group) => {
                const groupItems = items.filter((item) => item.group === group);
                if (!groupItems.length) return null;
                return (
                  <div key={group} className="ep-cmd-group">
                    <div className="ep-cmd-group-label">{group}</div>
                    {groupItems.map((item) => {
                      const flatIndex = items.indexOf(item);
                      const active = flatIndex === selectedIndex;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`ep-cmd-item ${active ? "is-active" : ""}`}
                          onMouseEnter={() => setSelectedIndex(flatIndex)}
                          onClick={() => executeItem(item)}
                        >
                          <span className="ep-cmd-item-icon">{renderIcon(item.icon)}</span>
                          <span className="ep-cmd-item-main">
                            <strong>{item.label}</strong>
                            {item.hint ? <small>{item.hint}</small> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
