import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { Comments } from "./doc-comments";
vi.mock("@/lib/hooks", () => ({ useCapability: () => false }));
vi.mock("./doc-context", () => ({
  useDoc: () => ({
    docId: "doc_1",
    comments: [],
    commentsLoading: false,
    commentsError: false,
    drafts: [
      {
        id: "draft_1",
        version: "ver_1",
        quote: "hello",
        body: "",
        mentions: [],
        updatedAt: 0,
      },
    ],
    commentFilter: "open",
    setCommentFilter: vi.fn(),
    setActiveComment: vi.fn(),
    scrollDocumentTo: vi.fn(),
    unanchoredComments: new Set(),
    saveDraft: vi.fn(),
    discardDraft: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("accepts ordinary @ text without searching or inserting structured mentions", async () => {
  const search = vi
    .spyOn(api, "searchUsers")
    .mockResolvedValue({ items: [{ type: "user", id: "usr_alice", name: "Alice" }] });
  const create = vi.spyOn(api, "createComment").mockResolvedValue({
    id: "cmt_1",
    body: "Hi @alice",
    status: "open",
    author: { type: "user", id: "usr_1" },
    created_on_version_id: "ver_1",
  });
  const q = new QueryClient();
  render(
    <QueryClientProvider client={q}>
      <Comments mobile />
    </QueryClientProvider>,
  );
  await userEvent.type(screen.getByPlaceholderText("Add a comment…"), "Hi @alice");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(search).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      "doc_1",
      "ver_1",
      "Hi @alice",
      "hello",
      undefined,
      [],
    ),
  );
});
