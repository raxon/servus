import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setCsrfToken } from "../../src/web/api.js";

afterEach(() => {
  setCsrfToken("");
  vi.unstubAllGlobals();
});

describe("API requests on public HTTP", () => {
  it("sends an idempotent deployment with CSRF when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(255);
        return bytes;
      },
    });
    const fetchRequest = vi.fn(async () => new Response(JSON.stringify({ accepted: true })));
    vi.stubGlobal("fetch", fetchRequest);
    setCsrfToken("test-csrf");

    await expect(api("/services/service-id/deploy", {
      method: "POST",
      body: { revision: 1 },
      idempotent: true,
    })).resolves.toEqual({ accepted: true });

    expect(fetchRequest).toHaveBeenCalledWith("/api/v1/services/service-id/deploy", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ revision: 1 }),
      headers: expect.objectContaining({
        "X-CSRF-Token": "test-csrf",
        "Idempotency-Key": "ffffffff-ffff-4fff-bfff-ffffffffffff",
      }),
    }));
  });
});
