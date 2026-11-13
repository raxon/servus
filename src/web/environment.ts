import type { EnvironmentVariable } from "../shared/types.js";

export function parseEnvironment(text: string): EnvironmentVariable[] {
  const entries: EnvironmentVariable[] = [];
  const names = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match)
      throw new Error(
        `Line ${index + 1}: use KEY=value without spaces around the key.`,
      );
    const name = match[1]!;
    if (names.has(name))
      throw new Error(`Line ${index + 1}: ${name} is defined more than once.`);
    names.add(name);
    let value = match[2]!;
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"'))
        throw new Error(`Line ${index + 1}: close the quoted value.`);
      try {
        value = JSON.parse(value) as string;
      } catch {
        throw new Error(
          `Line ${index + 1}: use a complete double-quoted value with valid JSON escapes.`,
        );
      }
    } else if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'"))
        throw new Error(`Line ${index + 1}: close the quoted value.`);
      value = value.slice(1, -1);
    }
    entries.push({ name, value, secret: false });
  }
  return entries;
}

export function combineEnvironment(
  text: string,
  secrets: EnvironmentVariable[],
) {
  const plain = parseEnvironment(text);
  const names = new Set(plain.map((entry) => entry.name));
  for (const secret of secrets) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.name))
      throw new Error(
        `Invalid secret variable name: ${secret.name || "(empty)"}.`,
      );
    if (names.has(secret.name))
      throw new Error(
        `${secret.name} is defined more than once across variables and secrets.`,
      );
    if (secret.value === undefined && !secret.secretRef)
      throw new Error(`Enter a value for the new secret ${secret.name}.`);
    names.add(secret.name);
  }
  return [...plain, ...secrets.map((secret) => ({ ...secret, secret: true }))];
}

export function formatEnvironment(entries: EnvironmentVariable[]) {
  return entries
    .filter((entry) => !entry.secret && !entry.secretRef)
    .map((entry) => {
      const value = entry.value ?? "";
      const formatted =
        /[\r\n]/.test(value) || /^\s|\s$/.test(value) || /^["']/.test(value)
          ? JSON.stringify(value)
          : value;
      return `${entry.name}=${formatted}`;
    })
    .join("\n");
}
