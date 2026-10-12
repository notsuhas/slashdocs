import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Anchor,
  type DocumentKVEvent,
  type DocumentPresence,
  type Principal,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { useCapability } from "@/lib/hooks";
import { samePrincipal } from "@/lib/principals";

// The server lists a viewer for 45 seconds after their last report.
const PRESENCE_TTL = 45_000;
const HEARTBEAT_INTERVAL = 20_000;
const REPORT_INTERVAL = 2_000;
const RECONNECT_DELAY = 10_000;

export type Viewer = {
  principal: Principal;
  version?: string;
  anchor?: Partial<Anchor>;
  seenAt: number;
};

export type DocumentKVListener = (event: DocumentKVEvent) => void;

type DocumentEventHandlers = Partial<
  Record<"kv" | "document" | "comments" | "presence", DocumentKVListener>
> & { open?: () => void };

// useDocumentEvents holds one connection to the document event stream and
// passes each event to the handler for its kind. A session marks the
// connection as a viewer, whom the server lists until the stream ends.
export function useDocumentEvents(
  docId: string,
  handlers: DocumentEventHandlers,
  session?: string,
  enabled = true,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [attempt, setAttempt] = useState(0);
  const lastRevision = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const params = new URLSearchParams(session ? { session } : {});
    // The browser resumes dropped streams itself. Only a stream it gave up on
    // is opened again here, and it continues from the last event it saw.
    if (lastRevision.current)
      params.set("after_revision", String(lastRevision.current));
    const source = new EventSource(
      `/v1/documents/${encodeURIComponent(docId)}/kv/events?${params}`,
      { withCredentials: true },
    );
    source.onopen = () => handlersRef.current.open?.();
    // KV changes are unnamed messages; other kinds are named events.
    for (const kind of ["kv", "document", "comments", "presence"] as const) {
      source.addEventListener(kind === "kv" ? "message" : kind, (message) => {
        lastRevision.current = Math.max(
          lastRevision.current,
          Number(message.lastEventId) || 0,
        );
        let event: DocumentKVEvent;
        try {
          event = JSON.parse(message.data) as DocumentKVEvent;
        } catch {
          return;
        }
        handlersRef.current[kind]?.(event);
      });
    }
    let reconnect: number | undefined;
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      reconnect = window.setTimeout(() => setAttempt((n) => n + 1), RECONNECT_DELAY);
    };
    return () => {
      source.close();
      window.clearTimeout(reconnect);
    };
  }, [docId, session, attempt, enabled]);
}

// useDocumentStream is the document page's view of the event stream. It
// passes KV changes to subscribers, refreshes comments and the document when
// they change, and reports and tracks who is viewing.
export function useDocumentStream({
  docId,
  version,
  principal,
  onRemoteDocumentChange,
}: {
  docId: string;
  version: string;
  principal?: Principal;
  onRemoteDocumentChange: () => void;
}) {
  const q = useQueryClient();
  const realtime = useCapability("realtime");
  const [session] = useState(() => crypto.randomUUID());
  const kvListeners = useRef(new Set<DocumentKVListener>());
  const [sessions, setSessions] = useState<ReadonlyMap<string, Viewer>>(new Map());

  useDocumentEvents(
    docId,
    {
      open: () => setSessions(new Map()),
      kv: (event) => kvListeners.current.forEach((listener) => listener(event)),
      comments: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
      document: (event) => {
        if (!samePrincipal(event.updated_by, principal)) onRemoteDocumentChange();
        q.invalidateQueries({ queryKey: queryKeys.document(docId) });
        q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
      },
      presence: (event) => {
        const presence = event.data as DocumentPresence | undefined;
        const viewer = event.updated_by;
        if (!presence?.session || presence.session === session || !viewer) return;
        const key = `${viewer.type}:${viewer.id}:${presence.session}`;
        setSessions((current) => {
          const next = new Map(current);
          if (presence.left) next.delete(key);
          else
            next.set(key, {
              principal: { ...viewer, picture_url: presence.picture_url },
              version: presence.version,
              anchor: presence.anchor,
              seenAt: Date.now(),
            });
          return next;
        });
      },
    },
    session,
    realtime,
  );

  useEffect(() => {
    if (realtime) return;
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const latest = await api.getDocument(docId);
        if (stopped) return;
        if (latest.current_version_id && latest.current_version_id !== version)
          onRemoteDocumentChange();
        q.setQueryData(queryKeys.document(docId), latest);
        void q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
        void q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
      } catch {
        /* Existing query state retains the last successful document. */
      }
    };
    const interval = window.setInterval(() => void refresh(), 60000);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [docId, version, realtime, q, onRemoteDocumentChange]);

  // Viewers whose tab closed without a goodbye drop out after the TTL.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSessions((current) => {
        const oldest = Date.now() - PRESENCE_TTL;
        const live = [...current].filter(([, viewer]) => viewer.seenAt > oldest);
        return live.length === current.size ? current : new Map(live);
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // Report this viewer's place: at once on a version change, at most every
  // REPORT_INTERVAL while scrolling, and as a heartbeat otherwise.
  const place = useRef<{ version: string; anchor?: Partial<Anchor> }>({ version });
  const lastReport = useRef(0);
  const pendingReport = useRef<number | undefined>(undefined);
  const report = useCallback(() => {
    window.clearTimeout(pendingReport.current);
    pendingReport.current = undefined;
    lastReport.current = Date.now();
    if (realtime)
      api.postDocumentPresence(docId, { session, ...place.current }).catch(() => {});
  }, [docId, session, realtime]);
  const scheduleReport = useCallback(() => {
    if (pendingReport.current !== undefined) return;
    const wait = Math.max(0, lastReport.current + REPORT_INTERVAL - Date.now());
    pendingReport.current = window.setTimeout(report, wait);
  }, [report]);
  const reportViewport = useCallback(
    (anchor?: Partial<Anchor>) => {
      place.current = { ...place.current, anchor };
      scheduleReport();
    },
    [scheduleReport],
  );
  useEffect(() => {
    place.current = { version };
    scheduleReport();
  }, [version, scheduleReport]);
  useEffect(() => {
    const timer = window.setInterval(report, HEARTBEAT_INTERVAL);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(pendingReport.current);
      pendingReport.current = undefined;
    };
  }, [report]);

  const subscribeKV = useCallback((listener: DocumentKVListener) => {
    kvListeners.current.add(listener);
    return () => {
      kvListeners.current.delete(listener);
    };
  }, []);

  // One avatar per person, at their most recently active tab.
  const viewers = useMemo(() => {
    const byPrincipal = new Map<string, Viewer>();
    for (const viewer of sessions.values()) {
      if (samePrincipal(viewer.principal, principal)) continue;
      const key = `${viewer.principal.type}:${viewer.principal.id}`;
      if ((byPrincipal.get(key)?.seenAt ?? 0) <= viewer.seenAt) {
        byPrincipal.set(key, viewer);
      }
    }
    return [...byPrincipal.values()];
  }, [sessions, principal]);

  return { viewers, subscribeKV, reportViewport };
}
