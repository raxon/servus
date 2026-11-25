import { randomUuid } from "./random-uuid.js";
let csrfToken = "";
let sessionEpoch = 0;

export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function setCsrfToken(value: string) {
  if (value !== csrfToken) sessionEpoch += 1;
  csrfToken = value;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; binary?: Blob; csrf?: boolean; idempotent?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const requestEpoch = sessionEpoch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined && options.binary !== undefined) throw new Error("A request cannot contain both JSON and binary data.");
  if (options.binary !== undefined) headers["Content-Type"] = "application/octet-stream";
  else if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if ((method !== "GET" || options.csrf) && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  if (options.idempotent) headers["Idempotency-Key"] = randomUuid();
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "same-origin",
    signal: options.signal,
    ...(options.binary !== undefined ? {body:options.binary} : options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const content = await response.text();
  options.signal?.throwIfAborted();
  if (requestEpoch !== sessionEpoch) {
    throw new RequestError(0, "SESSION_CHANGED", "Your session changed. Please try again.");
  }
  let data: unknown;
  try {
    data = content ? JSON.parse(content) : undefined;
  } catch {
    throw new RequestError(
      response.status,
      "INVALID_RESPONSE",
      "The server returned an unreadable response.",
    );
  }
  if (!response.ok) {
    const problem = data as { error?: { code?: string; message?: string } };
    throw new RequestError(
      response.status,
      problem?.error?.code ?? "REQUEST_FAILED",
      problem?.error?.message ?? "The request could not be completed.",
    );
  }
  return data as T;
}

export async function apiDownload(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<{ blob: Blob; headers: Headers }> {
  const method = options.method ?? "POST";
  const requestEpoch = sessionEpoch;
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "same-origin",
    signal: options.signal,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    const content = await response.text();
    options.signal?.throwIfAborted();
    if (requestEpoch !== sessionEpoch) throw new RequestError(0, "SESSION_CHANGED", "Your session changed. Please try again.");
    let data: { error?: { code?: string; message?: string } } | undefined;
    try { data = content ? (JSON.parse(content) as { error?: { code?: string; message?: string } }) : undefined; } catch { /* ignore */ }
    throw new RequestError(response.status, data?.error?.code ?? "REQUEST_FAILED", data?.error?.message ?? "The download could not be completed.");
  }
  const blob = await response.blob();
  options.signal?.throwIfAborted();
  if (requestEpoch !== sessionEpoch) throw new RequestError(0, "SESSION_CHANGED", "Your session changed. Please try again.");
  return { blob, headers: response.headers };
}

export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
