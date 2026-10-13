import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api, type ServerConfig } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { DocBar } from "./doc-bar";
vi.mock("./doc-context", () => ({ useDoc: () => ({ printDocument: vi.fn() }) }));
vi.mock("./doc-share-sheet", () => ({
  ShareSheet: ({ canManageAccess }: { canManageAccess: boolean }) => (
    <div>{canManageAccess ? "Sharing editable" : "Sharing read only"}</div>
  ),
}));
afterEach(cleanup);
it.each([
  { ownerOnly: true, owner: false, editable: false },
  { ownerOnly: true, owner: true, editable: true },
  { ownerOnly: undefined, owner: false, editable: true },
])("respects server sharing policy %j", ({ ownerOnly, owner, editable }) => {
  const q = new QueryClient();
  const config: ServerConfig = {
    deployment: "org",
    org_name: "Test",
    everyone_label: "Anyone",
    provider_name: "Google",
    google_groups_enabled: false,
    labels_enabled: false,
    capabilities: { owner_managed_sharing: ownerOnly },
  };
  vi.spyOn(api, "getConfig").mockResolvedValue(config);
  vi.spyOn(api, "documentAccess").mockResolvedValue({
    current_role: "editor",
    items: [],
  });
  q.setQueryData(queryKeys.config(), config);
  q.setQueryData(queryKeys.documentAccess("doc_1"), {
    current_role: "editor",
    items: [],
  });
  render(
    <QueryClientProvider client={q}>
      <MemoryRouter>
        <DocBar
          title="Test"
          docId="doc_1"
          owner={{ type: "user", id: "owner" }}
          principal={{ type: "user", id: owner ? "owner" : "editor" }}
          current="ver_1"
          latest="ver_1"
          versions={[]}
          labels={[]}
          onSelectVersion={vi.fn()}
          viewers={[]}
          onFollowViewer={vi.fn()}
          commentsOpen={false}
          onToggleComments={vi.fn()}
          onShowShortcuts={vi.fn()}
          shareOpen={false}
          onShareOpenChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    screen.getByText(editable ? "Sharing editable" : "Sharing read only"),
  ).toBeInTheDocument();
});
