import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { loadMigrationStatements } from "../scripts/read-migrations";
import { hashToken } from "../app/src/auth/tokens";
import { normalizePatch, announceDocumentEvent } from "../app/src/services/state";
import type { Env } from "../app/src/env";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
async function runtime(
  ceiling = 0,
  groups = false,
  accelerated = false,
  groupsUnavailable = false,
) {
  const bundle = await build({
    stdin: {
      contents: `import { AsyncLocalStorage } from 'node:async_hooks'; import { DocumentRealtime as ProductionRealtime } from './workers/app/src/realtime/document-realtime.ts';
      export class DocumentRealtime extends ProductionRealtime {
        pages=0; queries=0; maxQueries=0; ceilingFailures=0; heartbeatInvocations=0; refreshInvocations=0; inactivityCloses=0; failAuthorization=false; budget=new AsyncLocalStorage();
        constructor(state,env){
          let self;
          const db=env.DB;
          const charge=()=>{const meter=self?.budget.getStore();if(meter){meter.queries++;self.maxQueries=Math.max(self.maxQueries,meter.queries);if(meter.queries>${ceiling || 100000}){self.ceilingFailures++;throw new Error('D1 exceeded 50 statement ceiling')}}};
          const wrap=(statement,sql)=>new Proxy(statement,{get(target,key){
            if(key==='bind')return (...args)=>wrap(target.bind(...args),sql);
            if(['first','all','run','raw'].includes(key))return (...args)=>{charge();if(self?.failAuthorization && sql.includes('WITH callers'))throw new Error('D1 temporarily unavailable');return target[key](...args)};
            const value=target[key];return typeof value==='function'?value.bind(target):value;
          }});
          env.DB=new Proxy(db,{get(target,key){
            if(key==='prepare')return sql=>wrap(target.prepare(sql),sql);
            if(key==='batch')return statements=>{for(const statement of statements)charge();return target.batch(statements)};
            const value=target[key];return typeof value==='function'?value.bind(target):value;
          }});
          super(state,env);self=this;
        }
        async heartbeat(sub){if(Date.now()-sub.lastDemandAt>45000)this.inactivityCloses++;return super.heartbeat(sub)}
        async page(...args){this.pages++;return super.page(...args)}
        async fetch(request){
          const path=new URL(request.url).pathname;
          // Test-only native consumer: host HTTP buffers must not manufacture
          // demand when asserting the producer's paging and inactivity bounds.
          if(path.endsWith('/consumer/open') || path.endsWith('/consumer/idle')) {
            const url=new URL(request.url);url.pathname='/v1/documents/doc/kv/events';
            const response=await super.fetch(new Request(url,request));
            this.controlledReader=response.body.getReader();
            const first=await this.controlledReader.read();
            if(path.endsWith('/consumer/idle')) {
              await new Promise(resolve=>setTimeout(resolve,55000));
              return new Response(null,{status:204});
            }
            return new Response(first.value);
          }
          if(path.endsWith('/consumer/read')) {
            const chunk=await this.controlledReader.read();
            return new Response(chunk.value,{headers:{'X-consumer-done':String(chunk.done)}});
          }
          if(path.endsWith('/consumer/cancel')) {
            await this.controlledReader.cancel();
            return new Response(null,{status:204});
          }

          if(path.endsWith('/age-demand')){for(const sub of this.subscribers)sub.lastDemandAt=Date.now()-45001;return new Response(null,{status:204})}
          if(path.endsWith('/fail-authorization')){this.failAuthorization=(await request.text())==='true';return new Response(null,{status:204})}
          if(path==='/heartbeat')this.heartbeatInvocations++;
          if(path==='/refresh-groups')this.refreshInvocations++;
          if(path.endsWith('/debug'))return Response.json({queries:this.queries,maxQueries:this.maxQueries,ceilingFailures:this.ceilingFailures,heartbeatInvocations:this.heartbeatInvocations,refreshInvocations:this.refreshInvocations,inactivityCloses:this.inactivityCloses,pages:this.pages,subscribers:[...this.subscribers].map(s=>({live:s.live?.length,page:s.page?.length,last:s.last,phase:s.phase}))});
          const meter={queries:0};
          const response=await this.budget.run(meter,()=>super.fetch(request));
          this.queries=meter.queries;return response;
        }
      };
      export default {fetch(request,env){ const id=new URL(request.url).pathname.split('/')[3];return env.DOCUMENT_REALTIME.get(env.DOCUMENT_REALTIME.idFromName(id)).fetch(request);}};`,
      resolveDir: process.cwd(),
    },
    plugins: accelerated
      ? [
          {
            name: "accelerated-realtime-timers",
            setup(plugin) {
              plugin.onLoad({ filter: /document-realtime\.ts$/ }, async (args) => ({
                contents: (await readFile(args.path, "utf8")).replaceAll("25000", "10"),
                loader: "ts",
              }));
            },
          },
        ]
      : [],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:async_hooks"],
    target: "es2022",
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    serviceBindings: groups
      ? {
          GOOGLE_GROUPS_FETCHER: async () =>
            groupsUnavailable
              ? new Response(null, { status: 503 })
              : Response.json({ memberships: [] }),
        }
      : {},
    durableObjects: {
      DOCUMENT_REALTIME: { className: "DocumentRealtime", useSQLite: true },
    },
    bindings: {
      APP_ORIGIN: "https://app.example.com",
      ...(groups
        ? {
            GOOGLE_GROUPS_ENABLED: "true",
            GOOGLE_GROUPS_CUSTOMER_ID: "Ctest",
            GOOGLE_GROUPS_ACCESS_TOKEN: "test-only-token",
          }
        : {}),
    },
  });
  cleanup.push(() => mf.dispose());
  const env = await mf.getBindings<Env>();
  for (const statement of await loadMigrationStatements())
    await env.DB.prepare(statement).run();
  const at = new Date().toISOString();
  for (const id of ["owner", "viewer"])
    await env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES(?,'google',?,?,?,?)",
    )
      .bind(id, id, `${id}@example.com`, id, at)
      .run();
  await env.DB.prepare(
    "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES('doc','Test','owner',?)",
  )
    .bind(at)
    .run();
  await env.DB.prepare(
    "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) VALUES('grant','doc','user','viewer','viewer','owner')",
  ).run();
  for (const id of ["owner", "viewer"])
    await env.DB.prepare(
      "INSERT INTO cli_credentials(id,token_hash,user_id,name,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(id, await hashToken(`slashdocs_cli_${id}`), id, id, at)
      .run();
  if (groups)
    for (const id of ["owner", "viewer"])
      await env.DB.prepare(
        "INSERT INTO google_group_membership_snapshots(user_id,customer_id,last_success_at) VALUES(?,'Ctest',?)",
      )
        .bind(id, Date.now())
        .run();
  const request = (
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
    user = "owner",
  ) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer slashdocs_cli_${user}`);
    return mf.dispatchFetch(`https://app.example.com/v1/documents/doc/${path}`, {
      ...init,
      headers: Object.fromEntries(headers),
    });
  };
  const patch = (set: Record<string, unknown>, user = "owner") =>
    request("kv", { method: "PATCH", body: JSON.stringify({ set }) }, user);
  async function controlledReader(query: string, headers: Record<string, string> = {}) {
    const response = await request(`consumer/open${query}`, { headers });
    expect(response.status).toBe(200);
    let first: Uint8Array | undefined = new Uint8Array(await response.arrayBuffer());
    return {
      async read() {
        if (first) {
          const value = first;
          first = undefined;
          return { value, done: false };
        }
        const response = await request("consumer/read");
        return {
          value: new Uint8Array(await response.arrayBuffer()),
          done: response.headers.get("X-consumer-done") === "true",
        };
      },
      async cancel() {
        await request("consumer/cancel");
      },
    };
  }
  return {
    mf,
    env,
    request,
    patch,
    controlledReader,
    setGroupsUnavailable(value: boolean) {
      groupsUnavailable = value;
    },
  };
}
describe("document state and real Durable Object streams", () => {
  it("relays cursors without storing them or advancing durable revisions", async () => {
    const f = await runtime();
    const reader = (await f.request("kv/events", {}, "viewer")).body!.getReader();
    cleanup.unshift(() => reader.cancel());
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      ": connected",
    );
    const pending = reader.read();
    const cursor = {
      session: "cursor_session",
      version: "version",
      points: [{ t: 1, path: "0.1", x: 0.2, y: 0.4 }],
    };
    expect(
      (await f.request("cursor", { method: "POST", body: JSON.stringify(cursor) }))
        .status,
    ).toBe(204);
    const frame = new TextDecoder().decode((await pending).value);
    expect(frame).toContain("event: cursor");
    expect(frame).not.toContain("id:");
    expect(frame).toContain('"id":"owner"');
    expect(
      await f.env.DB.prepare(
        "SELECT count(*) AS n FROM document_events WHERE kind='cursor'",
      ).first(),
    ).toEqual({ n: 0 });
    expect((await f.patch({ durable: true })).status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("id: 1");
    for (const input of [
      { ...cursor, points: [] },
      { ...cursor, points: [{ t: -1, x: 2, y: 0, path: "bad" }] },
      { ...cursor, session: "bad!" },
    ])
      expect(
        (await f.request("cursor", { method: "POST", body: JSON.stringify(input) }))
          .status,
      ).toBe(400);
    await f.env.DB.prepare("DELETE FROM document_grants WHERE id='grant'").run();
    expect(
      (
        await f.request(
          "cursor",
          { method: "POST", body: JSON.stringify(cursor) },
          "viewer",
        )
      ).status,
    ).toBe(403);
  });

  it("keeps more than 100 heartbeats within fresh D1 budgets and closes revoked or idle readers", async () => {
    const f = await runtime(50, false, true);
    const reader = (
      await f.request("kv/events?session=heartbeat_session", {}, "viewer")
    ).body!.getReader();
    cleanup.unshift(() => reader.cancel());
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      ": connected",
    );
    for (let i = 0; i < 120; i++) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("heartbeat stalled")), 10000),
        ),
      ]);
      expect(new TextDecoder().decode(chunk.value)).toContain(": keepalive");
    }
    expect(await (await f.request("debug")).json()).toMatchObject({
      ceilingFailures: 0,
    });
    const debug = (await (await f.request("debug")).json()) as {
      maxQueries: number;
      heartbeatInvocations: number;
    };
    expect(debug.maxQueries).toBeLessThanOrEqual(50);
    expect(debug.heartbeatInvocations).toBeGreaterThanOrEqual(120);
    await f.env.DB.prepare(
      "UPDATE cli_credentials SET revoked_at='now' WHERE id='viewer'",
    ).run();
    while (!(await reader.read()).done) {
      /* Drain earlier verified heartbeats. */
    }
    const idle = (
      await f.request("kv/events?session=heartbeat_idle")
    ).body!.getReader();
    cleanup.unshift(() => idle.cancel());
    await idle.read();
    await idle.cancel();
    // Advance only the recorded demand timestamp. Keep the production 45s
    // cutoff so parallel CPU load cannot expire an actively reading test client.
    await f.request("age-demand", { method: "POST" });
    await expect
      .poll(async () => (await f.request("debug")).json(), { timeout: 10000 })
      .toMatchObject({
        ceilingFailures: 0,
        inactivityCloses: 1,
        subscribers: [],
      });
    const leaves = await f.env.DB.prepare(
      "SELECT event_json FROM document_events WHERE kind='presence'",
    ).all<{ event_json: string }>();
    expect(leaves.results.map((row) => JSON.parse(row.event_json).data)).toEqual(
      expect.arrayContaining([
        { session: "heartbeat_session", left: true },
        { session: "heartbeat_idle", left: true },
      ]),
    );
  }, 30000);
  it("retries heartbeat authorization failures in a new invocation and replays deferred updates", async () => {
    const f = await runtime(50, false, true);
    const reader = (await f.request("kv/events", {}, "viewer")).body!.getReader();
    cleanup.unshift(() => reader.cancel());
    await reader.read();
    await f.request("fail-authorization", { method: "POST", body: "true" });
    const pending = reader.read();
    await f.patch({ deferred: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await (await f.request("debug")).json()).toMatchObject({
      subscribers: [{ last: 0 }],
      ceilingFailures: 0,
    });
    await f.request("fail-authorization", { method: "POST", body: "false" });
    let text = new TextDecoder().decode((await pending).value);
    while (!text.includes("id: 1\n"))
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"deferred"');
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([1]);
    expect(await (await f.request("debug")).json()).toMatchObject({
      ceilingFailures: 0,
    });
  });
  it("rechecks stale inherited group access on a heartbeat without a producer", async () => {
    const f = await runtime(50, true, true),
      at = new Date().toISOString();
    await f.env.DB.batch([
      f.env.DB.prepare(
        "INSERT INTO folders(id,title,title_key,owner_type,owner_id,created_at,updated_at) VALUES('folder','Folder','folder','user','owner',?,?)",
      ).bind(at, at),
      f.env.DB.prepare("UPDATE documents SET parent_folder_id='folder' WHERE id='doc'"),
      f.env.DB.prepare("DELETE FROM document_grants WHERE id='grant'"),
      f.env.DB.prepare(
        "INSERT INTO google_groups VALUES('groups/test','Ctest','team@example.com','Team',?)",
      ).bind(Date.now()),
      f.env.DB.prepare(
        "INSERT INTO google_group_memberships VALUES('viewer','groups/test')",
      ),
      f.env.DB.prepare(
        "INSERT INTO folder_grants VALUES('inherited','folder','google_group','groups/test','viewer','user','owner')",
      ),
    ]);
    const reader = (
      await f.request("kv/events?session=group_heartbeat", {}, "viewer")
    ).body!.getReader();
    cleanup.unshift(() => reader.cancel());
    await reader.read();
    await f.env.DB.prepare(
      "UPDATE google_group_membership_snapshots SET last_success_at=1 WHERE user_id='viewer'",
    ).run();
    // The fixture directory returns no memberships. The private refresh must
    // remove the old inherited access before another heartbeat is delivered.
    while (!(await reader.read()).done) {
      /* Drain heartbeats authorized before staleness. */
    }
    expect(await (await f.request("debug")).json()).toMatchObject({
      ceilingFailures: 0,
      subscribers: [],
    });
    const membership = await f.env.DB.prepare(
      "SELECT user_id FROM google_group_memberships WHERE user_id='viewer'",
    ).first();
    expect(membership).toBeNull();
  });
  it("pauses failed group refreshes without a self-call loop and retries on a heartbeat", async () => {
    const f = await runtime(50, true, false, true);
    await f.env.DB.batch([
      f.env.DB.prepare("DELETE FROM document_grants WHERE id='grant'"),
      f.env.DB.prepare(
        "INSERT INTO google_groups VALUES('groups/test','Ctest','team@example.com','Team',?)",
      ).bind(Date.now()),
      f.env.DB.prepare(
        "INSERT INTO google_group_memberships VALUES('viewer','groups/test')",
      ),
      f.env.DB.prepare(
        "INSERT INTO document_grants VALUES('group-grant','doc','google_group','groups/test','viewer','owner')",
      ),
    ]);
    const reader = (await f.request("kv/events", {}, "viewer")).body!.getReader();
    cleanup.unshift(() => reader.cancel());
    await reader.read();
    const pending = reader.read();
    await f.env.DB.prepare(
      "UPDATE google_group_membership_snapshots SET last_success_at=1 WHERE user_id='viewer'",
    ).run();
    const heartbeat = () =>
      f.env
        .DOCUMENT_REALTIME!.get(f.env.DOCUMENT_REALTIME!.idFromName("doc"))
        .fetch("https://realtime/heartbeat", { method: "POST", body: "0" });
    const debug = async () => (await f.request("debug")).json();
    await heartbeat();
    await expect.poll(debug).toMatchObject({ refreshInvocations: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await debug()).toMatchObject({
      refreshInvocations: 1,
      ceilingFailures: 0,
      subscribers: [{ last: 0, phase: "live" }],
    });
    // The directory cooldown also returns an unresolved snapshot; it must not
    // restart a private refresh/pump cycle before the next heartbeat either.
    await heartbeat();
    await expect.poll(debug).toMatchObject({ refreshInvocations: 2 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await debug()).toMatchObject({ refreshInvocations: 2 });
    f.setGroupsUnavailable(false);
    await f.env.DB.prepare(
      "UPDATE google_group_membership_snapshots SET last_attempt_at=1 WHERE user_id='viewer'",
    ).run();
    await heartbeat();
    expect((await pending).done).toBe(true);
    expect(await debug()).toMatchObject({
      refreshInvocations: 3,
      ceilingFailures: 0,
      subscribers: [],
    });
  });
  it("continues expired presence replay through fresh bounded invocations", async () => {
    const f = await runtime(50);
    const at = new Date(Date.now() - 120000).toISOString();
    const events = Array.from({ length: 1200 }, (_, index) => ({
      document_id: "doc",
      revision: index + 1,
      kind: "presence",
      changes: [],
      updated_at: at,
      updated_by: { type: "user", id: "owner" },
      data: { session: "expired_session" },
    }));
    await f.env.DB.prepare(
      "INSERT INTO document_events(document_id,revision,kind,event_json,updated_at) SELECT 'doc',json_extract(value,'$.revision'),'presence',value,? FROM json_each(?)",
    )
      .bind(at, JSON.stringify(events))
      .run();
    await f.env.DB.prepare("INSERT INTO document_revisions VALUES('doc',1200)").run();
    const reader = (await f.request("kv/events?after_revision=0")).body!.getReader();
    cleanup.unshift(() => reader.cancel());
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("expired replay stalled")), 10000),
      ),
    ]);
    expect(new TextDecoder().decode(chunk.value)).toBe(": connected\n\n");
    const debug = (await (await f.request("debug")).json()) as {
      maxQueries: number;
      ceilingFailures: number;
      pages: number;
    };
    expect(debug.ceilingFailures).toBe(0);
    expect(debug.maxQueries).toBeLessThanOrEqual(50);
    expect(debug.pages).toBeGreaterThan(32);
  }, 20000);
  it.each([16, 64])(
    "authorizes %i distinct CLI subscribers under a 50-statement producer ceiling",
    async (count) => {
      const f = await runtime(50);
      const at = new Date().toISOString();
      for (let i = 0; i < count; i++) {
        const id = `subscriber${i}`;
        await f.env.DB.batch([
          f.env.DB.prepare(
            "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES(?,'google',?,?,?,?)",
          ).bind(id, id, `${id}@example.com`, id, at),
          f.env.DB.prepare(
            "INSERT INTO cli_credentials(id,token_hash,user_id,name,created_at) VALUES(?,?,?,?,?)",
          ).bind(id, await hashToken(`slashdocs_cli_${id}`), id, id, at),
          f.env.DB.prepare(
            "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) VALUES(?,'doc','user',?,'viewer','owner')",
          ).bind(id, id),
        ]);
      }
      const readers = [];
      for (let i = 0; i < count; i++) {
        const response = await f.request(
          `kv/events?session=subscriber${i}`,
          {},
          `subscriber${i}`,
        );
        const reader = response.body!.getReader();
        readers.push(reader);
        cleanup.unshift(() => reader.cancel());
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          ": connected",
        );
      }
      expect((await f.patch({ fanout: 1 })).status).toBe(200);
      const debug = (await (await f.request("debug")).json()) as {
        queries: number;
        subscribers: unknown[];
      };
      expect(debug.queries).toBeLessThanOrEqual(12);
      expect(debug.subscribers).toHaveLength(count);
      for (const reader of readers)
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          '"fanout"',
        );
      await f.env.DB.prepare(
        "UPDATE cli_credentials SET revoked_at='now' WHERE id='subscriber0'",
      ).run();
      expect((await f.patch({ secret: 2 })).status).toBe(200);
      expect((await readers[0].read()).done).toBe(true);
      for (const reader of readers.slice(1))
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          '"secret"',
        );
      await f.env.DB.prepare(
        "UPDATE cli_credentials SET revoked_at='now' WHERE id LIKE 'subscriber%'",
      ).run();
      expect((await f.patch({ all_revoked: 3 })).status).toBe(200);
      expect(await (await f.request("debug")).json()).toMatchObject({
        subscribers: [],
      });
      const finalDebug = (await (await f.request("debug")).json()) as {
        queries: number;
      };
      expect(finalDebug.queries).toBeLessThanOrEqual(24);
      for (const reader of readers.slice(1))
        while (!(await reader.read()).done) {
          /* Drain earlier authorized presence leaves. */
        }
    },
    20000,
  );
  it("retains unverifiable subscribers and retries the persisted backlog without leaking updates", async () => {
    const f = await runtime(50);
    const reader = (await f.request("kv/events", {}, "viewer")).body!.getReader();
    cleanup.unshift(() => reader.cancel());
    await reader.read();
    await f.request("fail-authorization", { method: "POST", body: "true" });
    expect((await f.patch({ deferred: 1 })).status).toBe(200);
    expect(await (await f.request("debug")).json()).toMatchObject({
      subscribers: [{ last: 0 }],
    });
    await f.request("fail-authorization", { method: "POST", body: "false" });
    expect((await f.patch({ after: 2 })).status).toBe(200);
    let text = "";
    while (!text.includes("id: 2\n"))
      text += new TextDecoder().decode((await reader.read()).value);
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([
      1, 2,
    ]);
    await f.request("fail-authorization", { method: "POST", body: "true" });
    await f.patch({ hidden: 3 });
    await f.env.DB.prepare("DELETE FROM document_grants WHERE id='grant'").run();
    await f.request("fail-authorization", { method: "POST", body: "false" });
    await f.patch({ hidden: 4 });
    expect((await reader.read()).done).toBe(true);
  }, 20000);
  it("revalidates exact sessions, revoked service keys and disabled accounts", async () => {
    const f = await runtime(50),
      at = new Date().toISOString();
    for (const id of ["key", "disabled"]) {
      await f.env.DB.batch([
        f.env.DB.prepare(
          "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES(?,'service_account',?,'',?,?)",
        ).bind(id, id, id, at),
        f.env.DB.prepare(
          "INSERT INTO service_accounts(id,name,owner_user_id,created_by_user_id,created_at) VALUES(?,?,'owner','owner',?)",
        ).bind(id, id, at),
        f.env.DB.prepare(
          "INSERT INTO service_account_keys(id,service_account_id,name,token_hash,created_at) VALUES(?,?,?,?,?)",
        ).bind(id, id, id, await hashToken(`slashdocs_sa_${id}`), at),
        f.env.DB.prepare(
          "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) VALUES(?,'doc','service_account',?,'viewer','owner')",
        ).bind(id, id),
      ]);
    }
    for (const token of ["expiry", "logout"])
      await f.env.DB.prepare("INSERT INTO sessions VALUES(?,'viewer',?)")
        .bind(await hashToken(token), Math.floor(Date.now() / 1000) + 3600)
        .run();
    const readers = [];
    for (const headers of [
      { Authorization: "Bearer slashdocs_sa_key" },
      { Authorization: "Bearer slashdocs_sa_disabled" },
      { Cookie: "__Host-slashdocs_session=expiry" },
      { Cookie: "__Host-slashdocs_session=logout" },
    ]) {
      const response = await f.mf.dispatchFetch(
        "https://app.example.com/v1/documents/doc/kv/events",
        { headers },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      readers.push(reader);
      cleanup.unshift(() => reader.cancel());
      await reader.read();
    }
    await f.patch({ allowed: 1 });
    for (const reader of readers)
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        '"allowed"',
      );
    await f.env.DB.batch([
      f.env.DB.prepare(
        "UPDATE service_account_keys SET revoked_at='now' WHERE id='key'",
      ),
      f.env.DB.prepare(
        "UPDATE service_accounts SET disabled_at='now' WHERE id='disabled'",
      ),
      f.env.DB.prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?").bind(
        Math.floor(Date.now() / 1000),
        await hashToken("expiry"),
      ),
      f.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(
        await hashToken("logout"),
      ),
    ]);
    expect((await f.patch({ denied: 2 })).status).toBe(200);
    for (const reader of readers) expect((await reader.read()).done).toBe(true);
  });
  it.each([false, true])(
    "rechecks inherited group membership with stale=%s before delivering new data",
    async (stale) => {
      const f = await runtime(50, true),
        at = new Date().toISOString();
      await f.env.DB.batch([
        f.env.DB.prepare(
          "INSERT INTO folders(id,title,title_key,owner_type,owner_id,created_at,updated_at) VALUES('folder','Folder','folder','user','owner',?,?)",
        ).bind(at, at),
        f.env.DB.prepare(
          "UPDATE documents SET parent_folder_id='folder' WHERE id='doc'",
        ),
        f.env.DB.prepare("DELETE FROM document_grants WHERE id='grant'"),
        f.env.DB.prepare(
          "INSERT INTO google_groups VALUES('groups/test','Ctest','team@example.com','Team',?)",
        ).bind(Date.now()),
        f.env.DB.prepare(
          "INSERT INTO google_group_memberships VALUES('viewer','groups/test')",
        ),
        f.env.DB.prepare(
          "INSERT INTO folder_grants VALUES('inherited','folder','google_group','groups/test','viewer','user','owner')",
        ),
      ]);
      const viewer = (await f.request("kv/events", {}, "viewer")).body!.getReader();
      const owner = (await f.request("kv/events")).body!.getReader();
      cleanup.unshift(
        () => viewer.cancel(),
        () => owner.cancel(),
      );
      await viewer.read();
      await owner.read();
      await f.patch({ allowed: 1 });
      for (const reader of [viewer, owner])
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          '"allowed"',
        );
      await f.env.DB.prepare(
        "DELETE FROM google_group_memberships WHERE user_id='viewer'",
      ).run();
      if (stale)
        await f.env.DB.prepare(
          "UPDATE google_group_membership_snapshots SET last_success_at=1 WHERE user_id='viewer'",
        ).run();
      await f.patch({ private: 2 });
      expect((await viewer.read()).done).toBe(true);
      expect(new TextDecoder().decode((await owner.read()).value)).toContain(
        '"private"',
      );
    },
  );
  it("releases an abandoned stream and records its presence leave", async () => {
    const f = await runtime();
    // Keep a native consumer idle inside the actor. Undici can prefetch
    // keepalives after a host reader pauses or cancels, extending the lease.
    expect((await f.request("consumer/idle?session=idle_session")).status).toBe(204);
    const leave = await f.env.DB.prepare(
      "SELECT event_json FROM document_events WHERE kind='presence' ORDER BY revision DESC LIMIT 1",
    ).first<{ event_json: string }>();
    expect(leave && JSON.parse(leave.event_json)).toMatchObject({
      data: { session: "idle_session", left: true },
    });
  }, 65000);
  it("records a native consumer cancellation through the private close invocation", async () => {
    const f = await runtime();
    const reader = await f.controlledReader("?session=cancelled_session");
    await reader.read();
    await reader.cancel();
    await expect
      .poll(
        async () => {
          const leave = await f.env.DB.prepare(
            "SELECT event_json FROM document_events WHERE kind='presence' ORDER BY revision DESC LIMIT 1",
          ).first<{ event_json: string }>();
          return leave ? JSON.parse(leave.event_json) : null;
        },
        { timeout: 5000 },
      )
      .toMatchObject({ data: { session: "cancelled_session", left: true } });
  });
  it("bounds unread live events at 32 and disconnects overflow with a resumable leave", async () => {
    const f = await runtime();
    const response = await f.request("kv/events?session=overflow_session");
    const reader = response.body!.getReader();
    cleanup.unshift(() => reader.cancel());
    await reader.read();
    const value = "x".repeat(60000);
    let maximumLive = 0;
    for (let i = 0; i < 64; i++) {
      expect((await f.patch({ a: value + i, b: value, c: value })).status).toBe(200);
      const debug = (await (await f.request("debug")).json()) as {
        subscribers: Array<{ live: number; page: number }>;
      };
      for (const sub of debug.subscribers) {
        maximumLive = Math.max(maximumLive, sub.live);
        expect(sub.live).toBeLessThanOrEqual(32);
        expect(sub.page).toBeLessThanOrEqual(32);
      }
    }
    expect(maximumLive).toBe(32);
    expect(await (await f.request("debug")).json()).toMatchObject({ subscribers: [] });
    const leave = await f.env.DB.prepare(
      "SELECT event_json FROM document_events WHERE kind='presence'",
    ).first<{ event_json: string }>();
    expect(JSON.parse(leave!.event_json)).toMatchObject({
      data: { session: "overflow_session", left: true },
    });
    // The remote HTTP pipe can retain already-delivered bytes; drain to closure.
    while (!(await reader.read()).done) {
      /* Drain. */
    }
    const resumed = await f.request("kv/events?after_revision=60");
    const resumedReader = resumed.body!.getReader();
    cleanup.unshift(() => resumedReader.cancel());
    let text = "";
    while (!text.includes(": connected"))
      text += new TextDecoder().decode((await resumedReader.read()).value);
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([
      61, 62, 63, 64, 65,
    ]);
    await resumedReader.cancel();
  }, 20000);
  it("lazily pages large replay and fills the replay/live gap exactly once", async () => {
    const f = await runtime();
    const at = new Date().toISOString();
    const event = (revision: number, kind = "kv", updated_at = at) => ({
      document_id: "doc",
      revision,
      kind,
      changes:
        kind === "kv"
          ? [
              {
                key: "large",
                value: "x".repeat(60000),
                revision,
                updated_at,
                updated_by: { type: "user", id: "owner" },
                operation: "set",
              },
            ]
          : [],
      updated_at,
      updated_by: { type: "user", id: "owner" },
    });
    for (let start = 1; start <= 112; start += 32)
      await f.env.DB.batch(
        Array.from({ length: Math.min(32, 113 - start) }, (_, i) => {
          const value = event(start + i);
          return f.env.DB.prepare(
            "INSERT INTO document_events(document_id,revision,kind,event_json,updated_at) VALUES('doc',?,'kv',?,?)",
          ).bind(value.revision, JSON.stringify(value), at);
        }),
      );
    await f.env.DB.prepare("INSERT INTO document_revisions VALUES('doc',112)").run();
    const reader = await f.controlledReader("?after_revision=0", {
      "Last-Event-ID": "2",
    });
    cleanup.unshift(() => reader.cancel());
    const before = (await (await f.request("debug")).json()) as {
      pages: number;
      subscribers: Array<{ page: number }>;
    };
    expect(before.pages).toBeLessThanOrEqual(1);
    expect(before.subscribers[0].page).toBeLessThanOrEqual(32);
    // Persist events without publication, including expired presence and >100 gaps.
    // A later published revision must cause lazy gap filling, not skip any backlog.
    for (let start = 113; start <= 224; start += 32)
      await f.env.DB.batch(
        Array.from({ length: Math.min(32, 225 - start) }, (_, i) => {
          const revision = start + i;
          const value = event(
            revision,
            revision === 150 ? "presence" : "comments",
            revision === 150 ? "2000-01-01T00:00:00.000Z" : at,
          );
          return f.env.DB.prepare(
            "INSERT INTO document_events(document_id,revision,kind,event_json,updated_at) VALUES('doc',?,?,?,?)",
          ).bind(revision, value.kind, JSON.stringify(value), value.updated_at);
        }),
      );
    await f.env.DB.prepare(
      "UPDATE document_revisions SET revision=224 WHERE document_id='doc'",
    ).run();
    await f.patch({ live: true });
    const paused = (await (await f.request("debug")).json()) as { pages: number };
    expect(paused.pages).toBeLessThanOrEqual(1);
    let text = "";
    while (!text.includes("id: 225\n"))
      text += new TextDecoder().decode((await reader.read()).value);
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual(
      Array.from({ length: 223 }, (_, i) => i + 3).filter((i) => i !== 150),
    );
    const after = (await (await f.request("debug")).json()) as { pages: number };
    expect(after.pages).toBeLessThanOrEqual(9);
    await reader.cancel();
  }, 20000);
  it("normalizes deletes and validates hostile keys and limits", () => {
    expect(normalizePatch({ set: { a: 1, b: null }, delete: ["a", "a"] })).toEqual({
      set: {},
      delete: ["a", "b"],
    });
    expect(() => normalizePatch({ set: { "bad key": 1 } })).toThrow("invalid KV key");
    expect(() => normalizePatch({ set: { a: "x".repeat(65537) } })).toThrow("64 KiB");
    expect(normalizePatch({ set: null, delete: null })).toEqual({
      set: {},
      delete: [],
    });
    const patch = normalizePatch(JSON.parse('{"set":{"__proto__":{"polluted":true}}}'));
    expect(Object.getPrototypeOf(patch.set)).toBeNull();
  });
  it("serializes concurrent mutations, persists events, supports inverse patches, and denies viewers", async () => {
    const f = await runtime();
    const results = (await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        f.patch({ [`key${i}`]: i }).then((r) => r.json()),
      ),
    )) as Array<{ revision: number }>;
    expect(results.map((r) => r.revision).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect((await f.patch({ a: 1 }, "viewer")).status).toBe(403);
    const deletion = await f.patch({ key0: null });
    expect(await deletion.json()).toMatchObject({ revision: 9 });
    const inverse = await f.patch({ key0: 0 });
    expect(await inverse.json()).toMatchObject({ revision: 10 });
    const noOp = await f.patch({});
    expect(await noOp.json()).toMatchObject({ revision: 10 });
    expect(await (await f.request("kv")).json()).toMatchObject({ items: { key0: 0 } });
    const large = await f.patch(
      Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`large${i}`, i])),
    );
    expect(large.status).toBe(200);
    const log = await f.env.DB.prepare(
      "SELECT count(*) AS n FROM document_events",
    ).first<{ n: number }>();
    expect(log?.n).toBe(11);
  });
  it("replays resumable unnamed KV events and named presence with server identity", async () => {
    const f = await runtime();
    await f.patch({ a: 1 });
    await f.patch({ b: 2 });
    await f.request(
      "presence",
      {
        method: "POST",
        body: JSON.stringify({
          session: "session_123",
          picture_url: "https://evil.example",
          left: true,
          anchor: { quote: "hi", dom_path: "secret" },
        }),
      },
      "viewer",
    );
    const response = await f.request(
      "kv/events?after_revision=0",
      { headers: { "Last-Event-ID": "1" } },
      "viewer",
    );
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    let text = new TextDecoder().decode(chunk.value);
    while (!text.includes(": connected"))
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("id: 2\ndata:");
    expect(text).not.toContain("id: 1\n");
    expect(text).toContain("event: presence\n");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("secret");
    expect(text).toContain('"updated_by":{"type":"user","id":"viewer"');
    await reader.cancel();
  });
  it("streams live updates and closes before delivering after permission or credential revocation", async () => {
    const f = await runtime();
    const response = await f.request("kv/events", {}, "viewer"),
      reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      ": connected",
    );
    await f.patch({ live: 1 });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"live"');
    await f.env.DB.prepare("DELETE FROM document_grants WHERE id='grant'").run();
    await f.patch({ secret: 2 });
    expect((await reader.read()).done).toBe(true);
    const ownerStream = await f.request("kv/events"),
      ownerReader = ownerStream.body!.getReader();
    await ownerReader.read();
    await f.env.DB.prepare(
      "UPDATE cli_credentials SET revoked_at='now' WHERE id='owner'",
    ).run();
    expect((await f.patch({ x: 1 })).status).toBe(401);
    await announceDocumentEvent(
      f.env,
      { principal: { type: "user", id: "viewer" }, credentialKind: "cli" },
      "doc",
      "comments",
    );
    expect((await ownerReader.read()).done).toBe(true);
  });
  it("shares revisions with document/comment events and records leave on revocation", async () => {
    const f = await runtime();
    const actor = {
      principal: { type: "user" as const, id: "owner" },
      credentialKind: "cli" as const,
    };
    await announceDocumentEvent(f.env, actor, "doc", "document");
    await announceDocumentEvent(f.env, actor, "doc", "comments");
    const result = await f.patch({ a: 1 });
    expect(await result.json()).toMatchObject({ revision: 3 });
    const response = await f.request("kv/events?session=session_leave", {}, "viewer"),
      reader = response.body!.getReader();
    await reader.read();
    await f.env.DB.prepare("DELETE FROM document_grants WHERE id='grant'").run();
    await f.patch({ after_revoke: true });
    expect((await reader.read()).done).toBe(true);
    const event = await f.env.DB.prepare(
      "SELECT event_json FROM document_events WHERE document_id='doc' ORDER BY revision DESC LIMIT 1",
    ).first<{ event_json: string }>();
    expect(JSON.parse(event!.event_json)).toMatchObject({
      revision: 5,
      kind: "presence",
      data: { session: "session_leave", left: true },
    });
  });
});
