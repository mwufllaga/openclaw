import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { withStrictWebToolsEndpoint, withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

describe("web-guarded-fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses trusted SSRF policy for trusted web tools endpoints", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withTrustedWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        policy: expect.objectContaining({
          dangerouslyAllowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
        }),
        proxy: "env",
        dangerouslyAllowEnvProxyWithoutPinnedDns: true,
      }),
    );
  });

  it("uses trusted SSRF policy for strict web tools endpoints (SSRF guard disabled)", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    // NOTE: SSRF guard is disabled for web tools - both strict and trusted endpoints
    // use the same permissive policy to allow private/internal IPs
    const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      url: "https://example.com",
      policy: {
        dangerouslyAllowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
      },
    });
  });
});
