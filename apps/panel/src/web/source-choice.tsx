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

export function SourceChoiceFields({ value, onChange, disabled = false }: { value: SourceChoice; onChange: (value: SourceChoice) => void; disabled?: boolean }) {
  const choices: { value: SourceChoice; label: string }[] = [
    { value: "image", label: "Docker image" },
    { value: "github", label: "GitHub" },
    { value: "git", label: "Git" },
  ];
  return <fieldset className="source-choice-group" disabled={disabled}>
    <legend>Source</legend>
    <div className="source-choice-options">
      {choices.map(choice => <label key={choice.value} className="source-choice-option">
        <input type="radio" name="source-choice" value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
        <span>{choice.label}</span>
      </label>)}
    </div>
  </fieldset>;
}
