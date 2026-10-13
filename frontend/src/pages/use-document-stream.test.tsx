import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { useDocumentStream } from "./use-document-stream";
const capability = vi.hoisted(() => ({ realtime: false }));
vi.mock("@/lib/hooks", () => ({ useCapability: () => capability.realtime }));
class EventSourceMock {
  addEventListener = vi.fn();
  close = vi.fn();
}
interface IProvider {
  children: ReactNode;
}
function setup() {
  const client = new QueryClient();
  function Provider(props: IProvider) {
    return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>;
  }
  return renderHook(
    () =>
      useDocumentStream({
        docId: "doc",
        version: "v1",
        onRemoteDocumentChange: vi.fn(),
      }),
    { wrapper: Provider },
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  capability.realtime = false;
  vi.stubGlobal("EventSource", EventSourceMock);
  vi.spyOn(api, "postDocumentPresence").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("does not send cursor traffic without realtime", async () => {
  const post = vi.spyOn(api, "postDocumentCursor").mockResolvedValue(undefined);
  const hook = setup();
  act(() => hook.result.current.moveCursor({ path: "0", x: 0.2, y: 0.4 }));
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(post).not.toHaveBeenCalled();
});
it("clears queued cursors when realtime is disabled and resumes when enabled", async () => {
  const post = vi.spyOn(api, "postDocumentCursor").mockResolvedValue(undefined);
  capability.realtime = true;
  const hook = setup();
  act(() => hook.result.current.moveCursor({ path: "0", x: 0.2, y: 0.4 }));
  capability.realtime = false;
  hook.rerender();
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(post).not.toHaveBeenCalled();
  capability.realtime = true;
  hook.rerender();
  act(() => hook.result.current.moveCursor({ path: "0", x: 0.3, y: 0.5 }));
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(post).toHaveBeenCalledOnce();
});

it("polls on schedule through typing renders and uses the newest callback", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .spyOn(api, "getDocument")
    .mockResolvedValue({ id: "doc_1", title: "Doc", current_version_id: "ver_2" });
  const first = vi.fn();
  const latest = vi.fn();
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (props: IProvider) => (
    <QueryClientProvider client={q}>{props.children}</QueryClientProvider>
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
