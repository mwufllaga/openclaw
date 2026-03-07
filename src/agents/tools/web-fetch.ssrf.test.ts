import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: makeHeaders({ location }),
    body: { cancel: vi.fn() },
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders({ "content-type": "text/plain" }),
    text: async () => body,
  } as unknown as Response;
}

function setMockFetch(
  impl: FetchMock = async (_input: RequestInfo | URL, _init?: RequestInit) => textResponse(""),
) {
  const fetchSpy = vi.fn<FetchMock>(impl);
  global.fetch = withFetchPreconnect(fetchSpy);
  return fetchSpy;
}

async function createWebFetchToolForTest(params?: {
  firecrawl?: { enabled?: boolean; apiKey?: string };
}) {
  const { createWebFetchTool } = await import("./web-tools.js");
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            firecrawl: params?.firecrawl ?? { enabled: false },
          },
        },
      },
    },
  });
}

describe("web_fetch SSRF protection", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockClear();
    vi.restoreAllMocks();
  });

  // NOTE: SSRF guard has been disabled for web tools.
  // The following tests verify that requests to private/internal addresses
  // are now allowed (previously they were blocked).

  it("allows localhost hostnames (SSRF guard disabled)", async () => {
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("localhost response"));
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
    });

    const result = await tool?.execute?.("call", { url: "http://localhost/test" });
    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.details).toMatchObject({
      status: 200,
      finalUrl: "http://localhost/test",
    });
  });

  it("allows private IP literals without DNS (SSRF guard disabled)", async () => {
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("private response"));
    const tool = await createWebFetchToolForTest();

    const cases = ["http://127.0.0.1/test", "http://[::ffff:127.0.0.1]/"] as const;
    for (const url of cases) {
      fetchSpy.mockClear();
      const result = await tool?.execute?.("call", { url });
      expect(fetchSpy).toHaveBeenCalled();
      expect(result?.details).toMatchObject({
        status: 200,
      });
    }
  });

  it("allows DNS resolves to private addresses (SSRF guard disabled)", async () => {
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "public.test") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "10.0.0.5", family: 4 }];
    });

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("private response"));
    const tool = await createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: "https://private.test/resource" });
    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.details).toMatchObject({
      status: 200,
    });
  });

  it("allows redirects to private hosts (SSRF guard disabled)", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchSpy = setMockFetch()
      .mockResolvedValueOnce(redirectResponse("http://127.0.0.1/secret"))
      .mockResolvedValueOnce(textResponse("redirected response"));
    const tool = await createWebFetchToolForTest({
      firecrawl: { apiKey: "firecrawl-test" },
    });

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result?.details).toMatchObject({
      status: 200,
    });
  });

  it("allows public hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = await createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expect(result?.details).toMatchObject({
      status: 200,
      extractor: "raw",
    });
  });
});
