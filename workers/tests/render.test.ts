import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv } from "./runtime";
import { signRenderCapability } from "../shared/render-capability";
import worker from "../render/src/index";

describe("isolated render worker", () => {
  let runtime: Awaited<ReturnType<typeof createTestEnv>>;
  beforeEach(async () => {
    runtime = await createTestEnv();
  });
  afterEach(async () => {
    await runtime.dispose();
  });
  const document = "doc_aaaaaaaa";
  const version = "ver_aaaaaaaa";
  const key = "documents/doc_aaaaaaaa/ver_aaaaaaaa.html";
  async function token(
    aud: "render" | "print" = "render",
    exp = Math.floor(Date.now() / 1000) + 60,
  ) {
    return signRenderCapability(runtime.env.RENDER_PRIVATE_KEY, {
      aud,
      document_id: document,
      version_id: version,
      object_key: key,
      exp,
    });
  }
  async function request(path: string, signed: string) {
    return worker.fetch(
      new Request(`https://render.example.com${path}?token=${signed}`),
      runtime.env,
    );
  }
  it("escapes uploaded markup into a nested srcdoc, clears capability before executing it, and locks response headers", async () => {
    await runtime.env.DOCUMENTS.put(
      key,
      '<html><head></head><body><script>window.attack="</script><script>"</script></body></html>',
    );
    const response = await request(`/v/${document}/${version}`, await token());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors https://app.example.com",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain('srcdoc="&lt;html&gt;');
    expect(html.indexOf("history.replaceState")).toBeLessThan(html.indexOf("<iframe"));
    expect(html).toContain('window.__SLASHDOCS_APP_ORIGIN__="https://app.example.com"');
    expect(html).not.toContain('window.attack="</script>');
  });
  it("rejects cross-document/version paths, wrong audience, expired and tampered signatures before fetching content", async () => {
    await runtime.env.DOCUMENTS.put(key, "private source");
    const signed = await token();
    expect((await request("/v/doc_bbbbbbbb/ver_aaaaaaaa", signed)).status).toBe(403);
    expect((await request("/v/doc_aaaaaaaa/ver_bbbbbbbb", signed)).status).toBe(403);
    expect((await request(`/print/${document}/${version}`, signed)).status).toBe(403);
    expect(
      (await request(`/v/${document}/${version}`, await token("render", 1))).status,
    ).toBe(403);
    expect(
      (await request(`/v/${document}/${version}`, signed.slice(0, -8) + "aaaaaaaa"))
        .status,
    ).toBe(403);
  });
  it("renders print only with a print capability and rejects app-host rendering", async () => {
    await runtime.env.DOCUMENTS.put(key, "<body>Printable</body>");
    const signed = await token("print");
    const response = await request(`/print/${document}/${version}`, signed);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("slashdocs-print-bootstrap");
    expect(
      (
        await worker.fetch(
          new Request(
            `https://app.example.com/print/${document}/${version}?token=${signed}`,
          ),
          runtime.env,
        )
      ).status,
    ).toBe(500);
  });
});
