import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "../../src/web/random-uuid.js";

afterEach(() => vi.unstubAllGlobals());

describe("randomUuid", () => {
  it("uses native randomUUID with the crypto receiver", () => {
    const nativeCrypto = {
      randomUUID: vi.fn(function (this: unknown) {
        expect(this).toBe(nativeCrypto);
        return "12345678-1234-4234-8234-123456789abc";
      }),
      getRandomValues: vi.fn(),
    };
    vi.stubGlobal("crypto", nativeCrypto);

    expect(randomUuid()).toBe("12345678-1234-4234-8234-123456789abc");
    expect(nativeCrypto.randomUUID).toHaveBeenCalledOnce();
    expect(nativeCrypto.getRandomValues).not.toHaveBeenCalled();
  });

  it.each([
    { byte: 0, expected: "00000000-0000-4000-8000-000000000000" },
    { byte: 255, expected: "ffffffff-ffff-4fff-bfff-ffffffffffff" },
  ])("formats cryptographic bytes as UUID v4 for byte $byte", ({ byte, expected }) => {
    const httpCrypto = {
      getRandomValues: vi.fn(function (this: unknown, bytes: Uint8Array) {
        expect(this).toBe(httpCrypto);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes).toHaveLength(16);
        bytes.fill(byte);
        return bytes;
      }),
    };
    vi.stubGlobal("crypto", httpCrypto);

    const uuid = randomUuid();
    expect(uuid).toBe(expected);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(httpCrypto.getRandomValues).toHaveBeenCalledOnce();
  });
});
