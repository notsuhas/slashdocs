import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { useDocumentStream } from "./use-document-stream";
vi.mock("@/lib/hooks", () => ({ useCapability: () => false }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("polls on schedule through typing renders and uses the newest callback", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .spyOn(api, "getDocument")
    .mockResolvedValue({ id: "doc_1", title: "Doc", current_version_id: "ver_2" });
  const first = vi.fn();
  const latest = vi.fn();
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={q}>{children}</QueryClientProvider>
  );
  const { rerender } = renderHook(
    ({ callback }) =>
      useDocumentStream({
        docId: "doc_1",
        version: "ver_1",
        onRemoteDocumentChange: callback,
      }),
    { wrapper, initialProps: { callback: first } },
  );
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    rerender({ callback: vi.fn() });
  }
  rerender({ callback: latest });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
