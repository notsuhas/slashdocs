import { afterEach, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { loadMigrationStatements } from "../scripts/read-migrations";
import {
  requestDocumentAccess,
  wakeNotificationDelivery,
  type NotificationEnv,
} from "../app/src/services/notifications";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
it("delivers an access request through a real SQLite Durable Object alarm with external HTTP mocked", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {NotificationDelivery} from './workers/app/src/notifications/delivery.ts';export default {fetch(){return new Response('test')}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  let posted = false;
  const calls: string[] = [];
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    durableObjects: {
      NOTIFICATION_DELIVERY: { className: "NotificationDelivery", useSQLite: true },
    },
    bindings: {
      APP_ORIGIN: "https://app.example.com",
      SLASHDOCS_SLACK_BOT_TOKEN: "test-token",
    },
    async outboundService(
      request: Pick<Request, "url" | "method" | "headers" | "text">,
    ) {
      const url = new URL(request.url);
      if (url.origin !== "https://slack.com")
        throw new Error("Unexpected external HTTP");
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe("Bearer test-token");
      calls.push(url.pathname);
      const raw = await request.text();
      if (url.pathname === "/api/users.lookupByEmail") {
        expect(raw).toBe("email=owner%40example.com");
        return Response.json({ ok: true, user: { id: "U" } });
      }
      if (url.pathname === "/api/conversations.open") {
        expect(JSON.parse(raw)).toEqual({ users: "U" });
        return Response.json({ ok: true, channel: { id: "D" } });
      }
      if (url.pathname === "/api/chat.postMessage") {
        const msg: unknown = JSON.parse(raw);
        expect(msg).toMatchObject({
          channel: "D",
          parse: "none",
          link_names: false,
          mrkdwn: false,
        });
        expect(raw).toContain("Review access");
        posted = true;
        return Response.json({ ok: true });
      }
      throw new Error("Unexpected Slack method");
    },
  });
  cleanup.push(() => mf.dispose());
  const env = await mf.getBindings<NotificationEnv>();
  for (const sql of await loadMigrationStatements()) await env.DB.prepare(sql).run();
  const now = new Date().toISOString();
  for (const id of ["owner", "reader"])
    await env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES(?,'google',?,?,?,?)",
    )
      .bind(id, id, id + "@example.com", id, now)
      .run();
  await env.DB.prepare(
    "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES('doc','Document','owner',?)",
  )
    .bind(now)
    .run();
  await requestDocumentAccess(
    env,
    {
      principal: {
        type: "user",
        id: "reader",
        email: "reader@example.com",
        name: "Reader",
      },
      credentialKind: "session",
    },
    "doc",
  );
  await wakeNotificationDelivery(env);
  // Continued activity must not keep moving the earliest delivery alarm.
  for (let wake = 0; wake < 15; wake++) {
    await wakeNotificationDelivery(env);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (wake === 10) expect(posted).toBe(true);
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) n FROM document_access_request_notification_outbox",
    ).first<{ n: number }>();
    if (posted && row?.n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  expect(posted).toBe(true);
  expect(calls).toEqual([
    "/api/users.lookupByEmail",
    "/api/conversations.open",
    "/api/chat.postMessage",
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM document_access_request_notification_outbox",
    ).first(),
  ).toEqual({ n: 0 });
});

it.each([null, 60000])(
  "preserves a concurrent wake when alarm finalization read %s from D1",
  async (futureDelay) => {
    let reached: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished: () => void = () => {};
    const completed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let minimumReads = 0;
    const bundle = await build({
      stdin: {
        contents: `
          import { NotificationDelivery as Delivery } from './workers/app/src/notifications/delivery.ts';
          export class NotificationDelivery extends Delivery {
            constructor(state, env) {
              const db = {
                prepare(sql) {
                  const statement = env.DB.prepare(sql);
                  if (!sql.startsWith('SELECT MIN(')) return statement;
                  return { async first() {
                    const result = await statement.first();
                    await env.PAUSE.fetch('https://pause.internal/');
                    return result;
                  }};
                },
              };
              super(state, { ...env, DB: db });
              this.testState = state;
              this.testEnv = env;
            }
            async alarm() {
              await super.alarm();
              await this.testEnv.FINISH.fetch('https://finish.internal/');
            }
            async fetch(request) {
              const path = new URL(request.url).pathname;
              if (path === '/test/run') { await super.alarm(); return new Response(null, {status: 204}); }
              if (path === '/test/alarm') return Response.json(await this.testState.storage.getAlarm());
              return super.fetch(request);
            }
          }
          export default { fetch() { return new Response('test'); } };
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
    });
    const mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-30",
      d1Databases: ["DB"],
      durableObjects: {
        NOTIFICATION_DELIVERY: { className: "NotificationDelivery", useSQLite: true },
      },
      bindings: {
        APP_ORIGIN: "https://app.example.com",
        SLASHDOCS_SLACK_BOT_TOKEN: "test-token",
      },
      serviceBindings: {
        PAUSE: async () => {
          minimumReads++;
          reached();
          await resume;
          return new Response();
        },
        FINISH: () => {
          finished();
          return new Response();
        },
      },
      outboundService: () => {
        throw new Error("Unexpected external HTTP");
      },
    });
    cleanup.push(() => mf.dispose());
    const env = await mf.getBindings<NotificationEnv>();
    for (const sql of await loadMigrationStatements()) await env.DB.prepare(sql).run();
    await env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES('owner','google','owner','owner@example.com','Owner',?)",
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES('doc','Document','owner',?)",
    )
      .bind(new Date().toISOString())
      .run();
    const insert = (id: string, available: number) =>
      env.DB.prepare(
        "INSERT INTO document_access_request_notification_outbox(document_id,requester_type,requester_id,requester_label,recipient_id,available_at,created_at) VALUES('doc','user',?,'Requester','owner',?,?)",
      )
        .bind(id, available, Date.now())
        .run();
    if (futureDelay !== null) await insert("future", Date.now() + futureDelay);
    const namespace = env.NOTIFICATION_DELIVERY;
    if (!namespace) throw new Error("Missing notification binding");
    const stub = namespace.get(namespace.idFromName("notifications"));
    await wakeNotificationDelivery(env);
    try {
      await paused;
      await insert("concurrent", Date.now() + 30000);
      await wakeNotificationDelivery(env);
      const before: unknown = await (
        await stub.fetch("https://delivery.internal/test/alarm")
      ).json();
      expect(typeof before).toBe("number");
      // A recovery alarm firing while the first pass is paused must return
      // without starting another D1 pass, and concurrent wakes keep the earliest.
      expect((await stub.fetch("https://delivery.internal/test/run")).status).toBe(204);
      await Promise.all(Array.from({ length: 8 }, () => wakeNotificationDelivery(env)));
      expect(minimumReads).toBe(1);
      release();
      await completed;
      const after: unknown = await (
        await stub.fetch("https://delivery.internal/test/alarm")
      ).json();
      expect(after).toBe(before);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM document_access_request_notification_outbox",
        ).first(),
      ).toEqual({ n: futureDelay === null ? 1 : 2 });
    } finally {
      release();
      await completed;
    }
  },
);
