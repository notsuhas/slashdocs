import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { APIError, api } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { AdminPage } from "./admin";
vi.mock("@/components/razorsense-backdrop", () => ({ RazorSenseBackdrop: () => null }));
afterEach(cleanup);
function setup(admin: boolean) {
  const me = {
    principal: { type: "user", id: "user" },
    is_admin: admin,
  } satisfies Awaited<ReturnType<typeof api.me>>;
  vi.spyOn(api, "me").mockResolvedValue(me);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.me(), me);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
it("does not request platform statistics for ordinary users", async () => {
  const stats = vi.spyOn(api, "adminStats");
  setup(false);
  expect(await screen.findByText("Admin access required")).toBeInTheDocument();
  expect(stats).not.toHaveBeenCalled();
});
it("shows load errors rather than inventing zero statistics", async () => {
  vi.spyOn(api, "adminStats").mockRejectedValue(new Error("unavailable"));
  setup(true);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load statistics",
  );
  expect(screen.queryByText("Signed-up users")).not.toBeInTheDocument();
});
it("shows metrics and distinguishes untracked dates from zero usage", async () => {
  const today = new Date().toISOString().slice(0, 10);
  vi.spyOn(api, "adminStats").mockResolvedValue({
    users: 12,
    active_24h: 2,
    active_7d: 4,
    active_30d: 6,
    logged_in_users: 3,
    sessions: 4,
    documents: 9,
    versions: 10,
    storage_bytes: 512,
    unknown_size_versions: 1,
    comments: 7,
    service_accounts: 1,
    tracking_since: today,
    daily: [{ day: today, requests: 20, active_users: 2 }],
  });
  setup(true);
  await waitFor(() => expect(screen.getByText("Signed-up users")).toBeInTheDocument());
  expect(screen.getByText("12")).toBeInTheDocument();
  expect(screen.getAllByText("—")).toHaveLength(58);
  expect(screen.getAllByRole("row")).toHaveLength(31);
});

const visibleStats = {
  users: 12,
  active_24h: 2,
  active_7d: 4,
  active_30d: 6,
  logged_in_users: 3,
  sessions: 4,
  documents: 9,
  versions: 10,
  storage_bytes: 512,
  unknown_size_versions: 0,
  comments: 7,
  service_accounts: 1,
  tracking_since: new Date().toISOString().slice(0, 10),
  daily: [],
};
it.each([401, 403])("clears cached statistics after a %s response", async (status) => {
  const fetchStats = vi.spyOn(api, "adminStats").mockResolvedValue(visibleStats);
  const client = setup(true);
  expect(await screen.findByText("Signed-up users")).toBeInTheDocument();
  if (status === 401)
    vi.mocked(api.me).mockRejectedValue(
      new APIError(401, "unauthorized", "Session expired"),
    );
  else
    vi.mocked(api.me).mockResolvedValue({
      principal: { type: "user", id: "user" },
      is_admin: false,
    });
  fetchStats.mockRejectedValue(new APIError(status, "forbidden", "Access denied"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.queryByText("Signed-up users")).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(client.getQueryData(queryKeys.adminStats())).toBeUndefined(),
  );
  expect(
    await screen.findByText(
      status === 401 ? "Session expired" : "Admin access required",
    ),
  ).toBeInTheDocument();
});
it("retains the last successful statistics during an availability failure", async () => {
  const fetchStats = vi.spyOn(api, "adminStats").mockResolvedValue(visibleStats);
  setup(true);
  expect(await screen.findByText("Signed-up users")).toBeInTheDocument();
  fetchStats.mockRejectedValue(new APIError(503, "unavailable", "Try later"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load statistics",
  );
  expect(screen.getByText("Signed-up users")).toBeInTheDocument();
});
