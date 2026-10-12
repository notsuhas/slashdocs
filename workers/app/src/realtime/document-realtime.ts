import { Hono } from "hono";
import type { Actor, AppEnv, Env } from "../env";
import type { DocumentKVEvent, DocumentPresence } from "../../../shared/contracts";
import { ApiError } from "../../../shared/errors";
import { requireAuth } from "../auth/middleware";
import { realtimeAuthorization, requireDocument } from "../services/permissions";
import { refreshActorGroups } from "../services/groups";
import { appendEvent, patchState, snapshot } from "../services/state";
const encoder = new TextEncoder();
export function eventFrame(event: DocumentKVEvent, withID = true) {
  return `${withID ? `id: ${event.revision}\n` : ""}${event.kind && event.kind !== "kv" ? `event: ${event.kind}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
}
async function authenticate(env: Env, request: Request): Promise<Actor> {
  let actor: Actor | undefined;
  const auth = new Hono<AppEnv>();
  auth.use("*", requireAuth);
  auth.all("*", (c) => {
    actor = c.get("actor");
    return c.body(null, 204);
  });
  auth.onError((error) => {
    throw error;
  });
  await auth.fetch(request, env);
  if (!actor) throw new ApiError(401, "unauthorized", "Authentication required");
  return actor;
}
export class DocumentRealtime {
  private subscribers = new Set<ReturnType<DocumentRealtime["subscription"]>>();
  private refreshing = new Set<string>();
  private heartbeats = new Set<number>();
  private nextSubscription = 0;
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    // SQLite storage is required by the Free plan; the canonical event log remains in D1.
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS realtime_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
  }
  private async serial<T>(task: () => Promise<T>): Promise<T> {
    const result = await this.state.blockConcurrencyWhile(async () => {
      try {
        return { ok: true as const, value: await task() };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (["/resume", "/heartbeat", "/close"].includes(path)) {
        const key: unknown = await request.json();
        if (typeof key !== "number" || !Number.isSafeInteger(key))
          return new Response(null, { status: 400 });
        await this.serial(async () => {
          const sub = [...this.subscribers].find((sub) => sub.key === key);
          if (!sub) return;
          if (path === "/close") await this.close(sub);
          else if (path === "/heartbeat") await this.heartbeat(sub);
          else await this.pump(sub);
        });
        return new Response(null, { status: 204 });
      }
      if (new URL(request.url).pathname === "/refresh-groups") {
        const actor: Actor = await request.json();
        await refreshActorGroups(this.env, actor);
        await this.serial(async () => {
          for (const sub of this.subscribers) {
            if (sub.actor.principal.id === actor.principal.id) this.resume(sub);
          }
        });
        return new Response(null, { status: 204 });
      }
      if (new URL(request.url).pathname === "/announce") {
        const { id, actor, kind } = (await request.json()) as {
          id: string;
          actor: Actor;
          kind: "document" | "comments";
        };
        await this.serial(async () => {
          const event = await appendEvent(this.env, actor, id, kind);
          await this.publish(event);
        });
        return new Response(null, { status: 204 });
      }
      const actor = await authenticate(this.env, request);
      const match = /\/v1\/documents\/([^/]+)\/(kv(?:\/events)?|presence)$/.exec(
        new URL(request.url).pathname,
      );
      if (!match) return new Response(null, { status: 404 });
      const id = decodeURIComponent(match[1]);
      if (match[2] === "kv/events" && request.method === "GET")
        return await this.serial(() => this.stream(request, actor, id));
      if (match[2] === "kv" && request.method === "GET")
        return Response.json(await this.serial(() => snapshot(this.env, actor, id)));
      if (match[2] === "kv" && request.method === "PATCH") {
        const body = await request.text();
        if (encoder.encode(body).length > 262144)
          throw new ApiError(413, "payload_too_large", "KV patch exceeds 256 KiB");
        let input: unknown;
        try {
          input = JSON.parse(body);
        } catch {
          throw new ApiError(400, "bad_request", "invalid KV patch");
        }
        return await this.serial(async () => {
          const { result, event } = await patchState(this.env, actor, id, input);
          if (event) await this.publish(event);
          return Response.json(result);
        });
      }
      if (match[2] === "presence" && request.method === "POST") {
        await requireDocument(this.env, actor, id, "viewer");
        const body = await request.text();
        if (encoder.encode(body).length > 4096)
          throw new ApiError(400, "bad_request", "invalid presence");
        let data: DocumentPresence;
        try {
          data = JSON.parse(body);
        } catch {
          throw new ApiError(400, "bad_request", "invalid presence");
        }
        this.validatePresence(data);
        const anchor = data.anchor
          ? {
              quote: data.anchor.quote ?? "",
              prefix: data.anchor.prefix ?? "",
              suffix: data.anchor.suffix ?? "",
              start_offset: data.anchor.start_offset ?? 0,
              end_offset: data.anchor.end_offset ?? 0,
            }
          : undefined;
        await this.serial(async () => {
          const event = await appendEvent(this.env, actor, id, "presence", {
            session: data.session,
            ...(data.version ? { version: data.version } : {}),
            ...(anchor ? { anchor } : {}),
            ...(actor.principal.picture_url
              ? { picture_url: actor.principal.picture_url }
              : {}),
          });
          await this.publish(event);
        });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    } catch (error) {
      const e =
        error instanceof ApiError
          ? error
          : new ApiError(500, "internal", "Request failed");
      return Response.json(
        { error: { code: e.code, message: e.message } },
        { status: e.status },
      );
    }
  }
  private validatePresence(data: DocumentPresence) {
    const a = data?.anchor;
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.session !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(data.session) ||
      (data.version !== undefined &&
        (typeof data.version !== "string" ||
          encoder.encode(data.version).length > 64)) ||
      (a != null &&
        (!a ||
          typeof a !== "object" ||
          Array.isArray(a) ||
          [a.quote ?? "", a.prefix ?? "", a.suffix ?? ""].some(
            (s, i) => typeof s !== "string" || [...s].length > (i === 0 ? 512 : 64),
          ) ||
          !Number.isInteger(a.start_offset ?? 0) ||
          !Number.isInteger(a.end_offset ?? 0) ||
          (a.start_offset ?? 0) < 0 ||
          (a.end_offset ?? 0) < (a.start_offset ?? 0)))
    )
      throw new ApiError(400, "bad_request", "invalid presence");
  }
  private invoke(
    sub: ReturnType<DocumentRealtime["subscription"]>,
    path: "/resume" | "/heartbeat" | "/close",
  ) {
    if (!this.env.DOCUMENT_REALTIME) return;
    if (path === "/heartbeat") {
      if (this.heartbeats.has(sub.key)) return;
      this.heartbeats.add(sub.key);
    }
    // Timers and response callbacks retain the opening request's D1 budget.
    // Schedule a fresh private invocation; never await a self-call under serial().
    this.state.waitUntil(
      this.env.DOCUMENT_REALTIME.get(this.state.id)
        .fetch(`https://realtime${path}`, {
          method: "POST",
          body: JSON.stringify(sub.key),
        })
        .catch(() => {})
        .finally(() => {
          if (path === "/heartbeat") this.heartbeats.delete(sub.key);
        }),
    );
  }
  private resume(sub: ReturnType<DocumentRealtime["subscription"]>) {
    if (sub.demand) this.invoke(sub, "/resume");
  }
  private async heartbeat(sub: ReturnType<DocumentRealtime["subscription"]>) {
    // Remote response cancellation may not invoke cancel(). Inactivity cleanup
    // and its presence publication also run in this fresh request budget.
    if (Date.now() - sub.lastDemandAt > 45000) {
      await this.close(sub);
      return;
    }
    try {
      if (!(await this.authorized(sub))) return;
      await this.pump(sub, true);
      if (sub.demand) this.send(sub, ": keepalive\n\n");
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        await this.close(sub);
      // Resource failures pause this tick; the next invocation can retry.
    }
  }
  private refreshGroups(sub: ReturnType<DocumentRealtime["subscription"]>) {
    const id = sub.actor.principal.id;
    if (this.refreshing.has(id) || !this.env.DOCUMENT_REALTIME) return;
    this.refreshing.add(id);
    // Do not await a self-call while holding blockConcurrencyWhile. Each
    // principal's directory refresh runs in its own D1 request budget.
    const stub = this.env.DOCUMENT_REALTIME.get(this.state.id);
    this.state.waitUntil(
      stub
        .fetch("https://realtime/refresh-groups", {
          method: "POST",
          body: JSON.stringify(sub.actor),
        })
        .catch(() => {})
        .finally(() => this.refreshing.delete(id)),
    );
  }
  private async authorized(sub: ReturnType<DocumentRealtime["subscription"]>) {
    const [status] = await realtimeAuthorization(this.env, [sub.actor], sub.id);
    if (status === "refresh") this.refreshGroups(sub);
    if (status === "denied") await this.close(sub);
    return status === "authorized";
  }
  private defer(sub: ReturnType<DocumentRealtime["subscription"]>, revision: number) {
    // The event is already persisted. Catch up lazily after verification works.
    sub.deferredThrough = Math.max(sub.deferredThrough ?? 0, revision);
    sub.page.length = 0;
    sub.pageEnd = undefined;
  }
  private async publish(event: DocumentKVEvent) {
    const subscribers = [...this.subscribers].filter(
      (sub) => sub.id === event.document_id && event.revision > sub.last,
    );
    let statuses: Awaited<ReturnType<typeof realtimeAuthorization>>;
    try {
      statuses = await realtimeAuthorization(
        this.env,
        subscribers.map((sub) => sub.actor),
        event.document_id,
      );
    } catch {
      for (const sub of subscribers) this.defer(sub, event.revision);
      return;
    }
    const leaves: ReturnType<DocumentRealtime["subscription"]>[] = [];
    for (const [index, sub] of subscribers.entries()) {
      if (!this.subscribers.has(sub)) continue;
      const status = statuses[index];
      if (status === "denied") {
        await this.close(sub, leaves);
        continue;
      }
      if (status !== "authorized") {
        this.defer(sub, event.revision);
        this.refreshGroups(sub);
        continue;
      }
      // Match Go's 32-event broker channel. HWM 0 alone does not bound enqueue().
      if (sub.live.length === 32) {
        await this.close(sub, leaves);
        continue;
      }
      sub.live.push(event);
      if (
        sub.phase === "live" &&
        sub.gapThrough === undefined &&
        sub.deferredThrough === undefined &&
        event.revision === sub.last + 1
      )
        await this.pump(sub, true);
      else this.resume(sub);
    }
    if (leaves.length) await this.recordLeaves(leaves);
  }
  private fresh(event: DocumentKVEvent) {
    return (
      event.kind !== "presence" ||
      Date.now() - Date.parse(event.updated_at ?? "") <= 45000
    );
  }
  private send(sub: ReturnType<DocumentRealtime["subscription"]>, frame: string) {
    sub.demand = false;
    sub.controller.enqueue(encoder.encode(frame));
  }
  private async page(
    sub: ReturnType<DocumentRealtime["subscription"]>,
    through: number,
    presence = false,
  ) {
    // Recheck authorization for each bounded page, rather than spending D1
    // queries on every replay row in a long-lived Free-plan request.
    if (!(await this.authorized(sub))) return;
    const rows = await this.env.DB.prepare(
      presence
        ? "SELECT event_json FROM document_events WHERE document_id=? AND revision>? AND revision<=? AND kind='presence' AND updated_at>? ORDER BY revision LIMIT 32"
        : "SELECT event_json FROM document_events WHERE document_id=? AND revision>? AND revision<=? ORDER BY revision LIMIT 32",
    )
      .bind(
        sub.id,
        presence ? sub.presenceLast : sub.last,
        through,
        ...(presence ? [new Date(Date.now() - 45000).toISOString()] : []),
      )
      .all<{ event_json: string }>();
    sub.page = rows.results.map((row) => row.event_json);
    // A short page includes the end of this interval, including deleted old
    // presence revisions. Do not repeatedly query a hole in the event log.
    sub.pageEnd = rows.results.length < 32 ? through : undefined;
  }
  private async pump(
    sub: ReturnType<DocumentRealtime["subscription"]>,
    verified = false,
  ) {
    if (!sub.demand || !this.subscribers.has(sub)) return;
    try {
      if (!verified && !(await this.authorized(sub))) return;
      let loadedPage = false;
      while (sub.demand && this.subscribers.has(sub)) {
        if (
          sub.phase === "replay" ||
          sub.phase === "presence" ||
          sub.gapThrough !== undefined
        ) {
          const presence = sub.phase === "presence";
          const through = sub.gapThrough ?? sub.replayThrough;
          if (!sub.page.length && sub.pageEnd === undefined) {
            // Expired presence can consume a whole page without sending a
            // frame. Continue in a fresh invocation rather than scanning an
            // unbounded number of pages against this request's D1 budget.
            if (loadedPage) {
              this.resume(sub);
              return;
            }
            loadedPage = true;
            await this.page(sub, through, presence);
          }
          if (
            !this.subscribers.has(sub) ||
            (!sub.page.length && sub.pageEnd === undefined)
          )
            return;
          const json = sub.page.shift();
          if (json !== undefined) {
            const event = JSON.parse(json) as DocumentKVEvent;
            if (presence) sub.presenceLast = event.revision;
            else sub.last = event.revision;
            if (this.fresh(event)) this.send(sub, eventFrame(event, !presence));
            continue;
          }
          if (sub.pageEnd !== undefined) {
            if (!presence) sub.last = Math.max(sub.last, sub.pageEnd);
            sub.pageEnd = undefined;
            if (sub.gapThrough !== undefined) sub.gapThrough = undefined;
            else sub.phase = presence ? "connected" : "presence";
          }
          continue;
        }
        if (sub.phase === "connected") {
          sub.phase = "live";
          this.send(sub, ": connected\n\n");
          return;
        }
        if (sub.deferredThrough !== undefined) {
          if (sub.deferredThrough > sub.last) sub.gapThrough = sub.deferredThrough;
          sub.deferredThrough = undefined;
          if (sub.gapThrough !== undefined) continue;
        }
        while (sub.live.length && sub.live[0].revision <= sub.last) sub.live.shift();
        const next = sub.live[0];
        if (!next) return;
        if (next.revision > sub.last + 1) {
          sub.gapThrough = next.revision - 1;
          continue;
        }
        sub.live.shift();
        sub.last = next.revision;
        if (this.fresh(next)) this.send(sub, eventFrame(next));
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        await this.close(sub);
      // Resource failures pause delivery; a later pull/heartbeat retries D1.
    }
  }
  private async recordLeaves(
    subscribers: ReturnType<DocumentRealtime["subscription"]>[],
  ) {
    const id = subscribers[0].id;
    const revision =
      (
        await this.env.DB.prepare(
          "SELECT revision FROM document_revisions WHERE document_id=?",
        )
          .bind(id)
          .first<{ revision: number }>()
      )?.revision ?? 0;
    const at = new Date().toISOString();
    const events: DocumentKVEvent[] = subscribers.map((sub, index) => ({
      document_id: id,
      revision: revision + index + 1,
      kind: "presence",
      changes: [],
      updated_at: at,
      updated_by: sub.actor.principal,
      data: { session: sub.session, left: true },
    }));
    const last = events[events.length - 1];
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO document_revisions(document_id,revision) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision",
      ).bind(id, last.revision),
      this.env.DB.prepare(
        "INSERT INTO document_events(document_id,revision,kind,event_json,updated_at) SELECT ?,json_extract(value,'$.revision'),'presence',value,? FROM json_each(?)",
      ).bind(id, at, JSON.stringify(events)),
      this.env.DB.prepare(
        "DELETE FROM document_events WHERE document_id=? AND kind='presence' AND updated_at<?",
      ).bind(id, new Date(Date.now() - 600000).toISOString()),
    ]);
    // Publishing the final revision makes earlier leaves a lazy persisted gap.
    // Each reader fills that gap in its own bounded invocation.
    await this.publish(last);
  }
  private async close(
    sub: ReturnType<DocumentRealtime["subscription"]>,
    leaves?: ReturnType<DocumentRealtime["subscription"]>[],
  ) {
    if (!this.subscribers.delete(sub)) return;
    clearInterval(sub.timer);
    sub.live.length = 0;
    sub.page.length = 0;
    try {
      sub.controller.close();
    } catch {
      /* Reader already canceled. */
    }
    if (sub.session) {
      if (leaves) {
        leaves.push(sub);
        return;
      }
      const event = await appendEvent(this.env, sub.actor, sub.id, "presence", {
        session: sub.session,
        left: true,
      });
      await this.publish(event);
    }
  }
  private subscription(
    controller: ReadableStreamDefaultController<Uint8Array>,
    request: Request,
    actor: Actor,
    id: string,
    session: string,
    last: number,
    replayThrough: number,
  ) {
    return {
      key: this.nextSubscription++,
      controller,
      request,
      actor,
      id,
      session,
      last,
      replayThrough,
      phase: "replay" as "replay" | "presence" | "connected" | "live",
      presenceLast: 0,
      live: [] as DocumentKVEvent[],
      page: [] as string[],
      pageEnd: undefined as number | undefined,
      gapThrough: undefined as number | undefined,
      deferredThrough: undefined as number | undefined,
      demand: false,
      lastDemandAt: Date.now(),
      timer: setInterval(() => {}, 25000),
    };
  }
  private async stream(request: Request, actor: Actor, id: string) {
    await requireDocument(this.env, actor, id, "viewer");
    const url = new URL(request.url),
      session = url.searchParams.get("session") ?? "";
    if (session && !/^[A-Za-z0-9_-]{8,64}$/.test(session))
      throw new ApiError(400, "bad_request", "invalid presence session");
    const after = url.searchParams.get("after_revision") ?? "",
      header = request.headers.get("Last-Event-ID") ?? "";
    if (
      [after, header].some(
        (v) => v !== "" && (!/^\+?\d+$/.test(v) || !Number.isSafeInteger(Number(v))),
      )
    )
      throw new ApiError(400, "bad_request", "invalid event revision");
    const current =
      (
        await this.env.DB.prepare(
          "SELECT revision FROM document_revisions WHERE document_id=?",
        )
          .bind(id)
          .first<{ revision: number }>()
      )?.revision ?? 0;
    const last = !after && !header ? current : Math.max(Number(after), Number(header));
    let sub: ReturnType<DocumentRealtime["subscription"]>;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          sub = this.subscription(
            controller,
            request,
            actor,
            id,
            session,
            last,
            current,
          );
          clearInterval(sub.timer);
          this.subscribers.add(sub);
          request.signal.addEventListener(
            "abort",
            () => {
              this.invoke(sub, "/close");
            },
            { once: true },
          );
          sub.timer = setInterval(() => this.invoke(sub, "/heartbeat"), 25000);
        },
        pull: () => {
          sub.lastDemandAt = Date.now();
          sub.demand = true;
          this.resume(sub);
        },
        cancel: () => this.invoke(sub, "/close"),
      },
      { highWaterMark: 0, size: (bytes) => bytes?.byteLength ?? 0 },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }
}
