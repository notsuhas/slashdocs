import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { Hono } from "hono";
import { createTestEnv, seedUser } from "./runtime";
import type { Actor, AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { grantRoutes } from "../app/src/routes/grants";
import { googleGroupRoutes } from "../app/src/routes/google-groups";
import {
  createFolder,
  effectiveAccess,
  requireFolder,
} from "../app/src/services/folders";
import { requireDocument, editorPredicateFor } from "../app/src/services/permissions";
import {
  groupMembershipUnavailable,
  refreshActorGroups,
  lookupGoogleGroup,
  searchGoogleGroups,
  transitiveGoogleGroups,
  type GroupsEnv,
} from "../app/src/services/groups";
import { resolveGrantPrincipal } from "../app/src/services/grant-principals";
const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(dispose.splice(0).map((fn) => fn()));
});
const labels = { "cloudidentity.googleapis.com/groups.discussion_forum": "" };
const group = {
  name: "groups/immutable",
  parent: "customers/Ctest",
  groupKey: { id: "team@example.com" },
  displayName: "Team",
  labels,
};
const relation = {
  group: group.name,
  groupKey: group.groupKey,
  displayName: group.displayName,
  labels,
};
async function fixture() {
  const runtime = await createTestEnv();
  dispose.push(runtime.dispose);
  const owner: Actor = {
    principal: await seedUser(runtime.env, "owner", "owner@example.com"),
    credentialKind: "session",
  };
  const member: Actor = {
    principal: await seedUser(runtime.env, "member", "member@example.com"),
    credentialKind: "session",
  };
  const sa: Actor = {
    principal: { type: "service_account", id: "machine", name: "build@nice.bot" },
    credentialKind: "service_account",
  };
  await runtime.env.DB.prepare(
    "INSERT INTO users(id,provider,provider_subject,email,name,picture_url,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      "machine",
      "service_account",
      "machine",
      "",
      "build@nice.bot",
      "",
      new Date().toISOString(),
    )
    .run();
  await runtime.env.DB.prepare("INSERT INTO service_accounts VALUES (?,?,?,?,?,NULL)")
    .bind("machine", "build@nice.bot", "member", "owner", new Date().toISOString())
    .run();
  const env: GroupsEnv = runtime.env;
  env.GOOGLE_GROUPS_ENABLED = "true";
  env.GOOGLE_GROUPS_CUSTOMER_ID = "Ctest";
  env.GOOGLE_GROUPS_ACCESS_TOKEN = "test-secret";
  let members: unknown[] = [relation],
    calls = 0,
    outage = false;
  env.GOOGLE_GROUPS_FETCHER = {
    fetch: async (input) => {
      calls++;
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (outage) return new Response("", { status: 503 });
      if (url.pathname.endsWith("groups:lookup"))
        return Response.json({ name: group.name });
      if (url.pathname.endsWith("groups:search"))
        return Response.json({ groups: [group] });
      if (url.pathname.endsWith("searchTransitiveGroups"))
        return Response.json({ memberships: members });
      return Response.json(group);
    },
  };
  const folder = await createFolder(env, owner, "Shared");
  await env.DB.prepare(
    "INSERT INTO documents(id,title,owner_user_id,updated_at,parent_folder_id) VALUES (?,?,?,?,?)",
  )
    .bind("doc", "Document", "owner", new Date().toISOString(), folder.id)
    .run();
  const app = new Hono<AppEnv>();
  let actor = owner;
  app.use("*", async (c, next) => {
    c.set("actor", await refreshActorGroups(c.env, actor));
    await next();
  });
  app.route("/", grantRoutes);
  app.route("/", googleGroupRoutes);
  app.onError((e, c) =>
    e instanceof ApiError
      ? c.json(
          { error: { code: e.code, message: e.message } },
          e.status === 503
            ? 503
            : e.status === 404
              ? 404
              : e.status === 403
                ? 403
                : 400,
        )
      : c.json({ error: String(e) }, 500),
  );
  return {
    ...runtime,
    env,
    owner,
    member,
    sa,
    folder,
    app,
    setActor: (a: Actor) => {
      actor = a;
    },
    setMembers: (v: unknown[]) => {
      members = v;
    },
    setOutage: (v: boolean) => {
      outage = v;
    },
    calls: () => calls,
  };
}
async function addFolderGrant(
  f: Awaited<ReturnType<typeof fixture>>,
  type: string,
  id: string,
  role = "editor",
) {
  await f.env.DB.prepare("INSERT INTO folder_grants VALUES (?,?,?,?,?,?,?)")
    .bind(`grant-${type}-${id}`, f.folder.id, type, id, role, "user", "owner")
    .run();
}
const json = (value: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
describe("Google directory and D1 grant parity", () => {
  it("keeps six columns and allows all Go principal types with inherited access", async () => {
    const f = await fixture();
    const columns = await f.env.DB.prepare("PRAGMA table_info(document_grants)").all();
    expect(columns.results).toHaveLength(6);
    await addFolderGrant(f, "user", "member", "commenter");
    await addFolderGrant(f, "service_account", "machine");
    expect((await requireDocument(f.env, f.member, "doc", "commenter")).role).toBe(
      "commenter",
    );
    expect((await requireDocument(f.env, f.sa, "doc", "editor")).role).toBe("editor");
    const resolved = await resolveGrantPrincipal(f.env, {
      principal: {
        type: "google_group",
        email: "team@example.com",
        id: "groups/attacker",
      },
    });
    expect(resolved.id).toBe(group.name);
    await addFolderGrant(f, "google_group", resolved.id);
    await refreshActorGroups(f.env, f.member);
    expect((await requireDocument(f.env, f.member, "doc", "editor")).role).toBe(
      "editor",
    );
    expect((await requireFolder(f.env, f.member, f.folder.id, "editor")).role).toBe(
      "editor",
    );
    const db = f.env.DB;
    const count = vi.fn((query: string) => db.prepare(query));
    const measured = {
      ...f.env,
      DB: new Proxy(db, {
        get(target, key) {
          return key === "prepare" ? count : Reflect.get(target, key);
        },
      }),
    };
    const items = await effectiveAccess(measured, "document", "doc");
    expect(count.mock.calls.length).toBeLessThanOrEqual(3);
    expect(
      items.find((x) => x.principal.type === "service_account")?.principal,
    ).toEqual({ type: "service_account", id: "machine", name: "build@nice.bot" });
    expect(items.find((x) => x.principal.id === "member")?.principal.email).toBe(
      "member@example.com",
    );
    expect(
      items.find((x) => x.principal.type === "google_group")?.principal.email,
    ).toBe("team@example.com");
    expect(
      items.find((x) => x.principal.type === "google_group")?.sources[0].resource_type,
    ).toBe("folder");
  });
  it("refreshes revocation, fails closed during outages, applies cooldown, and never inherits SA owner membership", async () => {
    const f = await fixture();
    await resolveGrantPrincipal(f.env, {
      principal: { type: "google_group", email: "team@example.com" },
    });
    await addFolderGrant(f, "google_group", group.name);
    await refreshActorGroups(f.env, f.member);
    expect((await requireDocument(f.env, f.member, "doc", "editor")).role).toBe(
      "editor",
    );
    await refreshActorGroups(f.env, f.sa);
    await expect(requireDocument(f.env, f.sa, "doc", "viewer")).rejects.toMatchObject({
      status: 403,
    });
    const before = f.calls();
    await refreshActorGroups(f.env, f.member);
    expect(f.calls()).toBe(before);
    await f.env.DB.prepare(
      "UPDATE google_group_membership_snapshots SET last_success_at=? WHERE user_id='member'",
    )
      .bind(Date.now() - 61000)
      .run();
    f.setOutage(true);
    await refreshActorGroups(f.env, f.member);
    await expect(
      requireDocument(f.env, f.member, "doc", "viewer"),
    ).rejects.toMatchObject({ status: 503 });
    const failed = f.calls();
    await refreshActorGroups(f.env, f.member);
    expect(f.calls()).toBe(failed);
    const cas = await f.env.DB.prepare(
      `UPDATE documents AS d SET title='unsafe' WHERE d.id='doc' AND ${editorPredicateFor(f.env)}`,
    )
      .bind("member", "member")
      .run();
    expect(cas.meta.changes).toBe(0);
    await f.env.DB.prepare(
      "UPDATE google_group_membership_snapshots SET last_attempt_at=? WHERE user_id='member'",
    )
      .bind(Date.now() - 6000)
      .run();
    f.setOutage(false);
    f.setMembers([]);
    await refreshActorGroups(f.env, f.member);
    await expect(
      requireDocument(f.env, f.member, "doc", "viewer"),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await f.env.DB.prepare(
          "SELECT * FROM google_group_memberships WHERE user_id='member'",
        ).all()
      ).results,
    ).toHaveLength(0);
  });
  it("lets inherited commenters mutate document grants including self-revocation with revision CAS", async () => {
    const f = await fixture();
    await addFolderGrant(f, "user", "member", "commenter");
    f.setActor(f.member);
    const created = await f.app.request(
      "/v1/documents/doc/grants",
      json({ address: "build@nice.bot", role: "editor" }),
      f.env,
    );
    expect(created.status).toBe(201);
    const body = z
      .object({ id: z.string(), principal: z.object({ type: z.string() }) })
      .parse(await created.json());
    expect(body.principal.type).toBe("service_account");
    const patched = await f.app.request(
      `/v1/documents/doc/grants/${body.id}`,
      { ...json({ role: "viewer" }), method: "PATCH" },
      f.env,
    );
    expect(patched.status).toBe(200);
    expect(
      (
        await f.env.DB.prepare(
          "SELECT access_revision FROM documents WHERE id='doc'",
        ).first<{ access_revision: number }>()
      )?.access_revision,
    ).toBe(2);
    expect(
      (
        await f.app.request(
          `/v1/documents/doc/grants/${body.id}`,
          { method: "DELETE" },
          f.env,
        )
      ).status,
    ).toBe(204);
    f.setActor(f.owner);
    expect(
      (
        await f.app.request(
          "/v1/documents/doc/grants",
          json({ principal: { type: "user", id: "owner" }, role: "viewer" }),
          f.env,
        )
      ).status,
    ).toBe(201);
    f.setActor(f.member);
    const self = await f.app.request(
      "/v1/documents/doc/grants",
      json({ principal: { type: "user", id: "member" }, role: "commenter" }),
      f.env,
    );
    const selfBody = z.object({ id: z.string() }).parse(await self.json());
    await f.env.DB.prepare(
      "DELETE FROM folder_grants WHERE principal_id='member'",
    ).run();
    expect(
      (
        await f.app.request(
          `/v1/documents/doc/grants/${selfBody.id}`,
          { method: "DELETE" },
          f.env,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await f.env.DB.prepare(
          "SELECT access_revision FROM documents WHERE id='doc'",
        ).first<{ access_revision: number }>()
      )?.access_revision,
    ).toBe(6);
  });
  it("maps disabled groups and dependency failures separately", async () => {
    const f = await fixture();
    f.env.GOOGLE_GROUPS_ENABLED = "false";
    expect((await f.app.request("/v1/google-groups?q=te", {}, f.env)).status).toBe(404);
    expect(
      (
        await f.app.request(
          "/v1/documents/doc/grants",
          json({
            principal: { type: "google_group", email: "team@example.com" },
            role: "viewer",
          }),
          f.env,
        )
      ).status,
    ).toBe(400);
    f.env.GOOGLE_GROUPS_ENABLED = "true";
    f.setOutage(true);
    expect((await f.app.request("/v1/google-groups?q=te", {}, f.env)).status).toBe(503);
  });
  it("paginates and deduplicates transitive groups and bounds repeated page tokens", async () => {
    const f = await fixture();
    let calls = 0;
    f.env.GOOGLE_GROUPS_FETCHER = {
      fetch: async () => {
        calls++;
        return Response.json({
          memberships: [relation, relation],
          nextPageToken: calls === 1 ? "next" : "",
        });
      },
    };
    expect(await transitiveGoogleGroups(f.env, "member@example.com")).toHaveLength(1);
    expect(calls).toBe(2);
    f.env.GOOGLE_GROUPS_FETCHER = {
      fetch: async () =>
        Response.json({ memberships: [relation], nextPageToken: "loop" }),
    };
    await expect(transitiveGoogleGroups(f.env, "member@example.com")).rejects.toThrow();
  });
  it("verifies immutable lookup identity, customer and managed type and escapes search input", async () => {
    const f = await fixture();
    for (const invalid of [
      { ...group, parent: "customers/Cother" },
      { ...group, labels: {} },
      { ...group, name: "groups/sub/path" },
    ]) {
      f.env.GOOGLE_GROUPS_FETCHER = {
        fetch: async (input) =>
          new URL(String(input)).pathname.endsWith("lookup")
            ? Response.json({ name: group.name })
            : Response.json(invalid),
      };
      await expect(lookupGoogleGroup(f.env, "team@example.com")).rejects.toMatchObject({
        status: 503,
      });
    }
    let query = "";
    f.env.GOOGLE_GROUPS_FETCHER = {
      fetch: async (input) => {
        query = new URL(String(input)).searchParams.get("query") ?? "";
        return Response.json({
          groups: [group, group, { ...group, parent: "customers/Cother" }],
        });
      },
    };
    expect(await searchGoogleGroups(f.env, "t'e\\am")).toHaveLength(1);
    expect(query).toContain("t\\'e\\\\am");
  });
  it("signs Google service account JWTs, exchanges tokens privately, and caches them", async () => {
    const f = await fixture();
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    f.env.GOOGLE_GROUPS_ACCESS_TOKEN = undefined;
    f.env.GOOGLE_GROUPS_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: "directory@project.iam.gserviceaccount.com",
      private_key: await exportPKCS8(privateKey),
      subject: "admin@example.com",
    });
    let exchanges = 0;
    f.env.GOOGLE_GROUPS_FETCHER = {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "oauth2.googleapis.com") {
          exchanges++;
          const fields = new URLSearchParams(String(init?.body));
          expect(fields.get("grant_type")).toBe(
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          );
          const { payload, protectedHeader } = await jwtVerify(
            fields.get("assertion") ?? "",
            publicKey,
            {
              issuer: "directory@project.iam.gserviceaccount.com",
              audience: "https://oauth2.googleapis.com/token",
            },
          );
          expect(protectedHeader.alg).toBe("RS256");
          expect(payload.sub).toBe("admin@example.com");
          expect(payload.scope).toBe(
            "https://www.googleapis.com/auth/cloud-identity.groups.readonly",
          );
          return Response.json({
            access_token: "private-exchanged-token",
            expires_in: 3600,
          });
        }
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer private-exchanged-token",
        );
        return Response.json({ groups: [group] });
      },
    };
    expect(await searchGoogleGroups(f.env, "Team")).toHaveLength(1);
    await searchGoogleGroups(f.env, "Team");
    expect(exchanges).toBe(1);
  });
  it("invalidates snapshots when the customer changes or sharing is disabled", async () => {
    const f = await fixture();
    await resolveGrantPrincipal(f.env, {
      principal: { type: "google_group", email: "team@example.com" },
    });
    await addFolderGrant(f, "google_group", group.name);
    await refreshActorGroups(f.env, f.member);
    f.env.GOOGLE_GROUPS_CUSTOMER_ID = "Cother";
    f.setOutage(true);
    await refreshActorGroups(f.env, f.member);
    await expect(
      requireDocument(f.env, f.member, "doc", "viewer"),
    ).rejects.toMatchObject({ status: 503 });
    const cas = await f.env.DB.prepare(
      `UPDATE documents AS d SET title='unsafe' WHERE d.id='doc' AND ${editorPredicateFor(f.env)}`,
    )
      .bind("member", "member")
      .run();
    expect(cas.meta.changes).toBe(0);
    f.env.GOOGLE_GROUPS_ENABLED = "false";
    await refreshActorGroups(f.env, f.member);
    await expect(
      requireDocument(f.env, f.member, "doc", "viewer"),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("matches the configured login provider when duplicate human and bot emails exist", async () => {
    const f = await fixture();
    await f.env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,picture_url,created_at) VALUES ('oidc-member','oidc','subject','member@example.com','SSO','',?)",
    )
      .bind(new Date().toISOString())
      .run();
    expect(
      (await resolveGrantPrincipal(f.env, { address: "member@example.com" })).id,
    ).toBe("member");
    f.env.SLASHDOCS_OIDC_ISSUER_URL = "https://issuer.example.com";
    expect(
      (await resolveGrantPrincipal(f.env, { address: "member@example.com" })).id,
    ).toBe("oidc-member");
    f.env.SLASHDOCS_OIDC_ISSUER_URL = "https://accounts.google.com";
    expect(
      (await resolveGrantPrincipal(f.env, { address: "member@example.com" })).id,
    ).toBe("member");
  });
});

describe("current deployment config survives late group refreshes", () => {
  it.each(["customer", "disabled"])(
    "rejects an old refresh after %s cleanup in reads and raw CAS",
    async (change) => {
      const f = await fixture();
      await addFolderGrant(f, "google_group", group.name);
      let release = () => {};
      let started = () => {};
      const pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const oldEnv: GroupsEnv = {
        ...f.env,
        GOOGLE_GROUPS_FETCHER: {
          fetch: async () => {
            started();
            await pause;
            return Response.json({ memberships: [relation] });
          },
        },
      };
      const oldRefresh = refreshActorGroups(oldEnv, f.member);
      await entered;
      const currentEnv: GroupsEnv = {
        ...f.env,
        GOOGLE_GROUPS_CUSTOMER_ID: change === "customer" ? "Cnew" : "Ctest",
        GOOGLE_GROUPS_ENABLED: change === "disabled" ? "false" : "true",
        GOOGLE_GROUPS_FETCHER: {
          fetch: async () => Response.json({ memberships: [] }),
        },
      };
      await refreshActorGroups(currentEnv, f.member);
      release();
      await oldRefresh;
      const snapshot = await currentEnv.DB.prepare(
        "SELECT customer_id FROM google_group_membership_snapshots WHERE user_id=?",
      )
        .bind(f.member.principal.id)
        .first<{ customer_id: string }>();
      expect(snapshot?.customer_id).toBe("Ctest");
      expect(await groupMembershipUnavailable(currentEnv, f.member)).toBe(
        change === "customer",
      );
      await expect(
        requireDocument(currentEnv, f.member, "doc", "editor"),
      ).rejects.toMatchObject({ status: change === "customer" ? 503 : 403 });
      await expect(
        requireFolder(currentEnv, f.member, f.folder.id, "editor"),
      ).rejects.toMatchObject({ status: change === "customer" ? 503 : 403 });
      const predicate = editorPredicateFor(currentEnv);
      expect(predicate.match(/\?/g)).toHaveLength(2);
      const rejected = await currentEnv.DB.prepare(
        `UPDATE documents AS d SET title='unsafe' WHERE d.id='doc' AND ${predicate}`,
      )
        .bind(f.member.principal.id, f.member.principal.id)
        .run();
      expect(rejected.meta.changes).toBe(0);
      await addFolderGrant(f, "user", f.member.principal.id);
      expect((await requireDocument(currentEnv, f.member, "doc", "editor")).role).toBe(
        "editor",
      );
      const direct = await currentEnv.DB.prepare(
        `UPDATE documents AS d SET title='safe' WHERE d.id='doc' AND ${predicate}`,
      )
        .bind(f.member.principal.id, f.member.principal.id)
        .run();
      expect(direct.meta.changes).toBe(1);
    },
  );
  it("fails closed for customer configuration that cannot be a safe SQL literal", async () => {
    const f = await fixture();
    await addFolderGrant(f, "google_group", group.name);
    await refreshActorGroups(f.env, f.member);
    const env = { ...f.env, GOOGLE_GROUPS_CUSTOMER_ID: "Ctest' OR 1=1 --" };
    await expect(requireDocument(env, f.member, "doc", "viewer")).rejects.toMatchObject(
      { status: 403 },
    );
    expect(
      (
        await env.DB.prepare(
          `UPDATE documents AS d SET title='unsafe' WHERE d.id='doc' AND ${editorPredicateFor(env)}`,
        )
          .bind(f.member.principal.id, f.member.principal.id)
          .run()
      ).meta.changes,
    ).toBe(0);
  });
});
