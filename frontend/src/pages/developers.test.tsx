import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api, type ServerConfig } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { DevelopersPage } from "./developers";
vi.mock("@/components/razorsense-backdrop", () => ({ RazorSenseBackdrop: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(capabilities?: ServerConfig["capabilities"]) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const q = new QueryClient();
  const config: ServerConfig = {
    deployment: "org",
    org_name: "Test",
    everyone_label: "Anyone",
    provider_name: "Google",
    google_groups_enabled: false,
    labels_enabled: false,
    capabilities,
  };
  vi.spyOn(api, "getConfig").mockResolvedValue(config);
  q.setQueryData(queryKeys.config(), config);
  render(
    <QueryClientProvider client={q}>
      <MemoryRouter>
        <DevelopersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it("shows the CLI while omitting unavailable foundation services", () => {
  setup({ mcp: false, service_accounts: false, api_reference: false });
  expect(screen.getByText("Open CLI setup guide")).toBeInTheDocument();
  expect(screen.queryByText("Connect an MCP client")).not.toBeInTheDocument();
  expect(screen.queryByText("Service account token")).not.toBeInTheDocument();
  expect(screen.queryByText("Manage service accounts")).not.toBeInTheDocument();
  expect(screen.queryByText("Swagger UI")).not.toBeInTheDocument();
  expect(screen.queryByText("Example: raw HTTP")).not.toBeInTheDocument();
});
it("keeps the full Go UI when no capability map is supplied", () => {
  setup();
  expect(screen.getByText("Connect an MCP client")).toBeInTheDocument();
  expect(screen.getByText("Manage service accounts")).toBeInTheDocument();
  expect(screen.getByText("Swagger UI")).toBeInTheDocument();
});
