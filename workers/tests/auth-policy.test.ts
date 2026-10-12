import { describe, expect, it } from "vitest";
import {
  emailAllowed,
  safeRedirect,
  loopbackRedirectAllowed,
} from "../app/src/auth/policy";
describe("login policy", () => {
  it("fails closed without an allowlist", () =>
    expect(emailAllowed("person@example.com", {})).toBe(false));
  it("compares whole normalized email or exact domain", () => {
    expect(
      emailAllowed("Person@EXAMPLE.com", { ALLOWED_EMAILS: " person@example.com " }),
    ).toBe(true);
    expect(
      emailAllowed("other@example.com", { ALLOWED_EMAILS: "person@example.com" }),
    ).toBe(false);
    expect(emailAllowed("person@example.com", { ALLOWED_DOMAINS: "EXAMPLE.com" })).toBe(
      true,
    );
    expect(
      emailAllowed("person@sub.example.com", { ALLOWED_DOMAINS: "example.com" }),
    ).toBe(false);
    expect(
      emailAllowed("person@evilexample.com", { ALLOWED_DOMAINS: "example.com" }),
    ).toBe(false);
  });
  it("rejects external and browser-normalized redirect tricks", () => {
    expect(safeRedirect("/documents")).toBe(true);
    for (const value of [
      "//example.com",
      "/\\example.com",
      "https://example.com",
      "/\n/example.com",
    ])
      expect(safeRedirect(value)).toBe(false);
  });
  it("limits CLI redirects to a loopback callback", () => {
    expect(loopbackRedirectAllowed("http://127.0.0.1:4321/callback")).toBe(true);
    for (const value of [
      "http://example.com/callback",
      "https://127.0.0.1:4321/callback",
      "http://user@127.0.0.1:4321/callback",
      "http://127.0.0.1:4321/other",
    ])
      expect(loopbackRedirectAllowed(value)).toBe(false);
  });
});
