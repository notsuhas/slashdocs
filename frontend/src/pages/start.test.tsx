import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api, type ServerConfig } from "@/api";
import { StartPage } from "./start";
vi.mock("@/components/razorsense-backdrop", () => ({ RazorSenseBackdrop: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it("retains an MCP setup path until configuration confirms it is unavailable", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  localStorage.setItem(
    "slashdocs.onboarding",
    JSON.stringify({ status: "active", path: "mcp", steps: {} }),
  );
  let resolveConfig: (config: ServerConfig) => void = () => {};
  vi.spyOn(api, "getConfig").mockReturnValue(
    new Promise((resolve) => {
      resolveConfig = resolve;
    }),
  );
  const config: ServerConfig = {
    deployment: "org",
    org_name: "Test",
    everyone_label: "Anyone",
    provider_name: "Google",
    google_groups_enabled: false,
    labels_enabled: false,
  };
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={q}>
      <MemoryRouter>
        <StartPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(JSON.parse(localStorage.getItem("slashdocs.onboarding") || "{}").path).toBe(
    "mcp",
  );
  await act(async () => {
    resolveConfig(config);
  });
  await waitFor(() => expect(q.getQueryData(["config"])).toBeDefined());
  expect(JSON.parse(localStorage.getItem("slashdocs.onboarding") || "{}").path).toBe(
    "mcp",
  );
  await act(async () => {
    q.setQueryData(["config"], { ...config, capabilities: { mcp: false } });
  });
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("slashdocs.onboarding") || "{}").path).toBe(
      "cli",
    ),
  );
});
