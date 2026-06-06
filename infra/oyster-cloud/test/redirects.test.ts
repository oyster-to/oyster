// 308s from the legacy oyster.to/app* URLs to app.oyster.to (spec
// invariant 7), including the /application boundary-guard negative the
// old www branch got wrong.
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const HOSTS = ["oyster.to", "www.oyster.to"] as const;

describe("legacy /app* → app.oyster.to 308s", () => {
  for (const host of HOSTS) {
    it(`${host}/app → app.oyster.to/`, async () => {
      const res = await SELF.fetch(`https://${host}/app`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/");
    });

    it(`${host}/app/ → app.oyster.to/`, async () => {
      const res = await SELF.fetch(`https://${host}/app/`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/");
    });

    it(`${host}/app/foo → app.oyster.to/foo`, async () => {
      const res = await SELF.fetch(`https://${host}/app/foo`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/foo");
    });

    it(`${host}/app/foo?a=1&b=2 preserves the query`, async () => {
      const res = await SELF.fetch(`https://${host}/app/foo?a=1&b=2`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/foo?a=1&b=2");
    });

    it(`${host}/application does NOT redirect (boundary guard)`, async () => {
      const res = await SELF.fetch(`https://${host}/application`, { redirect: "manual" });
      expect(res.status).not.toBe(308);
      expect(res.status).toBe(404);
    });
  }

  it("preserves the method semantics (308, not 301)", async () => {
    const res = await SELF.fetch("https://oyster.to/app/foo", { method: "POST", redirect: "manual" });
    expect(res.status).toBe(308);
  });
});
