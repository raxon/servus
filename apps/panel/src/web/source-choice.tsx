import { useId } from "react";
import { Box, Check, FolderGit2, GitBranch } from "lucide-react";
import type { SourceConfig } from "../shared/types.js";

export type SourceChoice = "image" | "github" | "git";

export function initialSourceChoice(source: SourceConfig): SourceChoice {
  if (source.type !== "git") return "image";
  try {
    const url = new URL(source.repository);
    if (url.protocol === "https:" && url.host.toLowerCase() === "github.com" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) return "github";
  } catch { /* Invalid stored URLs remain editable in the Git form. */ }
  return "git";
}

export function githubRepositoryName(repository: string): string {
  try {
    const url = new URL(repository);
    if (url.protocol === "https:" && url.host.toLowerCase() === "github.com" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) return url.pathname.replace(/^\//, "").replace(/\/$/, "");
  } catch { /* An empty or incomplete repository is edited as plain text. */ }
  return "";
}

export function githubRepositoryUrl(name: string): string {
  return `https://github.com/${name.trim()}`;
}

export function SourceChoiceFields({ value, onChange, disabled = false, detailed = false }: { value: SourceChoice; onChange: (value: SourceChoice) => void; disabled?: boolean; detailed?: boolean }) {
  const name = useId();
  const choices = [
    { value: "image" as const, label: "Docker image", description: "Pull a ready-to-run image", icon: Box },
    { value: "github" as const, label: "GitHub", description: "Build from a GitHub repository", icon: FolderGit2 },
    { value: "git" as const, label: "Git", description: "Build from another Git provider", icon: GitBranch },
  ];
  return <fieldset className={`source-choice-group${detailed ? " source-choice-detailed" : ""}`} disabled={disabled}>
    <legend>{detailed ? "Source type" : "Source"}</legend>
    <div className="source-choice-options">
      {choices.map(choice => <label key={choice.value} className="source-choice-option">
        <input type="radio" name={name} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} aria-labelledby={detailed ? `${name}-${choice.value}-label` : undefined} aria-describedby={detailed ? `${name}-${choice.value}-help` : undefined} />
        <span className="source-choice-content">
          {detailed ? <choice.icon size={21} aria-hidden="true" /> : null}
          {detailed ? <span className="source-choice-copy"><strong id={`${name}-${choice.value}-label`}>{choice.label}</strong><small id={`${name}-${choice.value}-help`}>{choice.description}</small></span> : choice.label}
          {detailed ? <Check className="source-choice-check" size={16} aria-hidden="true" /> : null}
        </span>
      </label>)}
    </div>
  </fieldset>;
}
