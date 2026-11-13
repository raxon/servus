let csrfToken = "";

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
  csrfToken = value;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotent?: boolean } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  if (options.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "same-origin",
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const content = await response.text();
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

export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
