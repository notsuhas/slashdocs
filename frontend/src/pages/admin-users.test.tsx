import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APIError, api, type AdminUser, type AdminDocument } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { AdminPage } from "./admin";
const person = {
  id: "suhas",
  name: "Suhas",
  email: "suhas@example.com",
  picture_url: "",
  created_at: "2026-10-01T12:00:00Z",
  last_login_at: "2026-10-13T09:00:00Z",
  last_active_at: "2026-10-13T09:30:00Z",
  sessions: 2,
  documents_uploaded: 2,
  versions_uploaded: 3,
  owned_documents: 1,
  requests_30d: 15,
} satisfies AdminUser;
const document = {
  id: "doc_shared",
  title: "Shared roadmap",
  owner_id: "carla",
  owner_type: "user",
  owner_name: "Carla",
  owner_email: "carla@example.com",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-13T09:30:00Z",
  first_upload_at: "2026-10-10T12:00:00Z",
  last_upload_at: "2026-10-13T09:30:00Z",
  versions_uploaded: 2,
  total_versions: 3,
  storage_bytes: 100,
  unknown_size_versions: 0,
} satisfies AdminDocument;
vi.mock("@/components/razorsense-backdrop", () => ({ RazorSenseBackdrop: () => null }));
beforeEach(() => {
  vi.spyOn(api, "me").mockResolvedValue({
    principal: { type: "user", id: "admin" },
    is_admin: true,
  });
  vi.spyOn(api, "adminStats").mockRejectedValue(new Error("overview unavailable"));
  vi.spyOn(api, "adminUsers").mockResolvedValue({ items: [person], has_more: false });
  vi.spyOn(api, "adminUserDocuments").mockResolvedValue({
    items: [document],
    has_more: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.me(), {
    principal: { type: "user", id: "admin" },
    is_admin: true,
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
it("opens on identities and drills into the person's actual documents", async () => {
  setup();
  expect(await screen.findByText("suhas@example.com")).toBeInTheDocument();
  expect(screen.getByText("Logged in")).toBeInTheDocument();
  expect(screen.queryByText("Signed-up users")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Suhas — View documents for suhas@example.com",
    }),
  );
  const link = await screen.findByRole("link", { name: "Shared roadmap" });
  expect(link).toHaveAttribute("href", "/app/d/doc_shared");
  expect(screen.getByText("carla@example.com")).toBeInTheDocument();
  expect(api.adminUserDocuments).toHaveBeenCalledWith("suhas", "uploaded", "", 1);
  fireEvent.click(screen.getByRole("button", { name: "Owned by this user" }));
  await waitFor(() =>
    expect(api.adminUserDocuments).toHaveBeenCalledWith("suhas", "owned", "", 1),
  );
});
it("searches and filters users, resetting pagination", async () => {
  vi.mocked(api.adminUsers).mockResolvedValue({ items: [person], has_more: true });
  setup();
  await screen.findByText("suhas@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Next users" }));
  await waitFor(() => expect(api.adminUsers).toHaveBeenCalledWith("", "all", 2));
  fireEvent.change(screen.getByLabelText("Filter users"), {
    target: { value: "logged_in" },
  });
  await waitFor(() => expect(api.adminUsers).toHaveBeenCalledWith("", "logged_in", 1));
  fireEvent.change(screen.getByLabelText("Search users by name or email"), {
    target: { value: " Suhas " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(api.adminUsers).toHaveBeenCalledWith("Suhas", "logged_in", 1),
  );
});
it.each([401, 403])(
  "removes identities and all admin caches when detail access returns %i",
  async (status) => {
    const client = setup();
    await screen.findByText("suhas@example.com");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Suhas — View documents for suhas@example.com",
      }),
    );
    await screen.findByRole("link", { name: "Shared roadmap" });
    vi.mocked(api.adminUserDocuments).mockRejectedValue(
      new APIError(status, "forbidden", "Access denied"),
    );
    await client.invalidateQueries({ queryKey: queryKeys.adminAll() });
    expect(
      await screen.findByText(
        status === 401 ? "Session expired" : "Admin access required",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("suhas@example.com")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Shared roadmap" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        client
          .getQueriesData({ queryKey: queryKeys.adminAll() })
          .every(([, data]) => data === undefined),
      ).toBe(true),
    );
  },
);
it("keeps identities on an ordinary outage and reports the failed refresh", async () => {
  const client = setup();
  await screen.findByText("suhas@example.com");
  vi.mocked(api.adminUsers).mockRejectedValue(
    new APIError(500, "internal", "Unavailable"),
  );
  await client.invalidateQueries({ queryKey: queryKeys.adminUsers("", "all", 1) });
  expect(
    await screen.findByText("Could not load users. Refresh to try again."),
  ).toBeInTheDocument();
  expect(screen.getByText("suhas@example.com")).toBeInTheDocument();
});

it("preserves a selected user's search across overview and resets it for a different user", async () => {
  const other = { ...person, id: "carla", name: "Carla", email: "carla@example.com" };
  vi.mocked(api.adminUsers).mockResolvedValue({
    items: [person, other],
    has_more: false,
  });
  setup();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Suhas — View documents for suhas@example.com",
    }),
  );
  await screen.findByRole("link", { name: "Shared roadmap" });
  fireEvent.change(screen.getByLabelText("Search this user's documents"), {
    target: { value: "roadmap" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search documents" }));
  await waitFor(() =>
    expect(api.adminUserDocuments).toHaveBeenCalledWith(
      "suhas",
      "uploaded",
      "roadmap",
      1,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Overview" }));
  fireEvent.click(screen.getByRole("button", { name: "Users and documents" }));
  expect(screen.getByLabelText("Search this user's documents")).toHaveValue("roadmap");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Carla — View documents for carla@example.com",
    }),
  );
  await waitFor(() =>
    expect(api.adminUserDocuments).toHaveBeenCalledWith("carla", "uploaded", "", 1),
  );
  expect(screen.getByLabelText("Search this user's documents")).toHaveValue("");
  expect(screen.getByLabelText("Documents for Carla")).toHaveFocus();
});
