import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import type { Actor, AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { createTestEnv, seedUser } from "./runtime";
import { documentRoutes } from "../app/src/routes/documents";
import { labelRoutes } from "../app/src/routes/labels";
import {
  createDocument,
  getDocument,
  listDocuments,
} from "../app/src/services/documents";
import { searchDateContext, searchPeriod } from "../app/src/services/search-dates";
import { parseDocumentSearch } from "../app/src/services/search-query";
import {
  lexemes,
  matchDocument,
  searchTerms,
  storedLexemes,
} from "../app/src/services/search-text";
import { replaceDocumentLabels } from "../app/src/services/labels";
import { createVersion } from "../app/src/services/versions";
import {
  extractHeadings,
  indexCurrentVersions,
  searchText,
} from "../app/src/services/source-metadata";
import * as searchTextService from "../app/src/services/search-text";
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});
const bytes = (html: string) => new TextEncoder().encode(html);
async function fixture(overrides: Record<string, string> = {}) {
  const runtime = await createTestEnv(overrides);
  disposers.push(runtime.dispose);
  const actor: Actor = {
    principal: await seedUser(runtime.env),
    credentialKind: "session",
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", documentRoutes);
  app.route("/", labelRoutes);
  app.onError((error, c) =>
    error instanceof ApiError
      ? c.json(
          { error: { code: error.code, message: error.message } },
          error.status as 400,
        )
      : c.json({ error: { code: "internal", message: error.message } }, 500),
  );
  return { ...runtime, actor, app };
}
const documentList = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    snippet: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
);
describe("Go search grammar", () => {
  it("keeps partial modifiers, quotes, exclusions and aliases identical", () => {
    const now = new Date("2026-03-14T20:00:00Z");
    expect(
      parseDocumentSearch(
        'from:@Alice author:me in:"Product Specs" in:#fld_1 labels:api,review label:ops',
        "usr_Me",
        now,
        "Asia/Kolkata",
      ),
    ).toMatchObject({
      terms: [],
      owners: ["alice", "usr_me"],
      folders: ["product specs", "fld_1"],
      labels: ["api", "review", "ops"],
    });
    expect(
      parseDocumentSearch('"Error budget" -draft -"old plan" it\'s', "me", now),
    ).toMatchObject({
      terms: ["error budget", "it's"],
      excluded: ["draft", "old plan"],
    });
    expect(
      parseDocumentSearch('plan from: on:2026-0 in:"Product', "me", now),
    ).toMatchObject({ terms: ["plan"], folders: ["product"] });
    expect(
      parseDocumentSearch(
        "after:last week budget on:monday may",
        "me",
        now,
        "Asia/Kolkata",
      ),
    ).toMatchObject({
      terms: ["budget", "may"],
      since: "2026-03-08T18:30:00.000Z",
      before: "2026-03-09T18:30:00.000Z",
    });
    expect(() => parseDocumentSearch("é".repeat(257), "me")).toThrow(
      "query is too long",
    );
    expect(() => parseDocumentSearch("from:a ".repeat(11), "me")).toThrow("at most 10");
  });
  it("ports every Go natural date fixture and converts each boundary in its zone", () => {
    const context = searchDateContext(new Date("2026-03-14T20:00:00Z"), "Asia/Kolkata");
    const fixtures: Record<string, [string, string]> = {
      "25-09-25": ["2025-09-25", "2025-09-26"],
      "25/09/2025": ["2025-09-25", "2025-09-26"],
      "5.3.26": ["2026-03-05", "2026-03-06"],
      "25-09": ["2025-09-25", "2025-09-26"],
      "2026-03-05": ["2026-03-05", "2026-03-06"],
      "2026-02": ["2026-02-01", "2026-03-01"],
      "2025": ["2025-01-01", "2026-01-01"],
      today: ["2026-03-15", "2026-03-16"],
      yesterday: ["2026-03-14", "2026-03-15"],
      monday: ["2026-03-09", "2026-03-10"],
      sunday: ["2026-03-15", "2026-03-16"],
      "last sunday": ["2026-03-08", "2026-03-09"],
      "last mon": ["2026-03-09", "2026-03-10"],
      september: ["2025-09-01", "2025-10-01"],
      mar: ["2026-03-01", "2026-04-01"],
      "sept 2024": ["2024-09-01", "2024-10-01"],
      "5th of september": ["2025-09-05", "2025-09-06"],
      "sep 5, 2024": ["2024-09-05", "2024-09-06"],
      "march 20": ["2025-03-20", "2025-03-21"],
      "this week": ["2026-03-09", "2026-03-16"],
      "last week": ["2026-03-02", "2026-03-09"],
      "this month": ["2026-03-01", "2026-04-01"],
      "last year": ["2025-01-01", "2026-01-01"],
      "3 days ago": ["2026-03-12", "2026-03-13"],
      "2 weeks ago": ["2026-03-01", "2026-03-02"],
      "last 7 days": ["2026-03-09", "2026-03-16"],
      "past 1 month": ["2026-02-16", "2026-03-16"],
    };
    for (const [phrase, period] of Object.entries(fixtures))
      expect(searchPeriod(phrase, context), phrase).toEqual(
        period.map((date) => new Date(`${date}T00:00:00+05:30`).toISOString()),
      );
    for (const phrase of [
      "",
      "budget",
      "last",
      "2026-0",
      "32-01-26",
      "31 feb",
      "5 6 march",
    ])
      expect(searchPeriod(phrase, context), phrase).toBeUndefined();
    expect(
      searchPeriod(
        "today",
        searchDateContext(new Date("2026-03-08T12:00:00Z"), "America/New_York"),
      ),
    ).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
    expect(() => parseDocumentSearch("", "me", new Date(), "not/a/zone")).toThrow(
      "invalid tz",
    );
  });
});
describe("indexed source metadata", () => {
  it("matches Go HTML text extraction, hidden elements, byte cap and heading IDs", () => {
    const html =
      '<html><head><title>Plan</title><style>p{color:red}</style><script>const secret = "<p>hidden</p>";</script></head><body><h1>Error&nbsp;budget</h1><p>Checkout <b>was</b> exceeded.</p><noscript>Enable JS</noscript><template><p>later</p></template><p>End\x02\x03</p></body></html>';
    expect(searchText(bytes(html))).toBe(
      "Plan Error budget Checkout was exceeded. End",
    );
    expect(
      new TextEncoder().encode(searchText(bytes("é".repeat(256 << 10)))).length,
    ).toBe(256 << 10);
    expect(
      extractHeadings(
        bytes(
          '<div id="rollout"></div><h2>Rollout</h2><h2 id="rollout-2">Explicit</h2><h2>Rollout</h2><h3>你好</h3><h3>Hello &amp; world</h3><template><h1>Ignored</h1></template>',
        ),
      ).map((h) => h.id),
    ).toEqual(["rollout-3", "rollout-2", "rollout-4", "section", "hello-world"]);
  });
  it("indexes on creation, searches current body with English stems, phrases and exclusions", async () => {
    const { env, actor } = await fixture();
    const incident = await createDocument(
      env,
      actor,
      "Q3 incident review",
      bytes(
        "<p>The error budget for checkout was exceeded twice.</p><script>secret</script>",
      ),
      "private",
    );
    const budget = await createDocument(
      env,
      actor,
      "Budget plan",
      bytes("<p>Planning notes.</p>"),
      "private",
    );
    expect((await listDocuments(env, actor, "budget")).map((d) => d.id)).toEqual([
      budget.id,
      incident.id,
    ]);
    for (const query of ["exceed check", "incident twice", '"error budget"'])
      expect((await listDocuments(env, actor, query)).map((d) => d.id)).toEqual([
        incident.id,
      ]);
    expect(await listDocuments(env, actor, '"budget error"')).toEqual([]);
    expect(
      (await listDocuments(env, actor, "budget -checkout")).map((d) => d.id),
    ).toEqual([budget.id]);
    expect(await listDocuments(env, actor, "secret")).toEqual([]);
    expect((await listDocuments(env, actor, "the")).map((d) => d.id)).toEqual([
      budget.id,
      incident.id,
    ]);
    expect((await listDocuments(env, actor, "budget"))[1].snippet).toContain(
      "\x02budget\x03",
    );
    await env.DB.prepare(
      "UPDATE versions SET search_text=NULL,headings_json=NULL",
    ).run();
    await env.DOCUMENTS.delete(
      `documents/${budget.id}/${budget.current_version_id}.html`,
    );
    expect(await listDocuments(env, actor, "twice")).toEqual([]);
    expect(await indexCurrentVersions(env)).toBe(2);
    expect(await indexCurrentVersions(env)).toBe(0);
    expect((await listDocuments(env, actor, "twice")).map((d) => d.id)).toEqual([
      incident.id,
    ]);
  });
  it("uses Go workspace discovery and org-wide search instead of bare public grants", async () => {
    const { env, actor } = await fixture();
    const doc = await createDocument(
      env,
      actor,
      "Discover",
      bytes("discoverable"),
      "viewer",
    );
    const other: Actor = {
      principal: await seedUser(env, "usr_discover", "discover@example.com"),
      credentialKind: "session",
    };
    expect(await listDocuments(env, other, "")).toEqual([]);
    expect(await listDocuments(env, other, "discover")).toEqual([]);
    await getDocument(env, other, doc.id);
    expect((await listDocuments(env, other, "")).map((d) => d.id)).toEqual([doc.id]);
    env.DEPLOYMENT = "org";
    expect((await listDocuments(env, other, "discover")).map((d) => d.id)).toEqual([
      doc.id,
    ]);
    await env.DB.prepare("DELETE FROM document_grants WHERE document_id=?")
      .bind(doc.id)
      .run();
    expect(await listDocuments(env, other, "")).toEqual([]);
  });
  it("returns Go headings and validates scoped document, version and comment links", async () => {
    const { env, actor, app } = await fixture();
    const doc = await createDocument(
      env,
      actor,
      "Links",
      bytes('<h1>Rollout</h1><h2 id="author-id">Heading</h2>'),
      "private",
    );
    const base = `/v1/documents/${doc.id}`;
    const headings = await app.request(base + "/headings", {}, env);
    expect(await headings.json()).toMatchObject({
      items: [
        {
          id: "rollout",
          text: "Rollout",
          level: 1,
          url: `${env.APP_ORIGIN}/app/d/${doc.id}#rollout`,
        },
        { id: "author-id" },
      ],
    });
    expect(
      await (
        await app.request(base + `/headings?version=${doc.current_version_id}`, {}, env)
      ).json(),
    ).toMatchObject({
      items: [
        {
          url: `${env.APP_ORIGIN}/app/d/${doc.id}?version=${doc.current_version_id}#rollout`,
        },
        {},
      ],
    });
    expect(
      await (
        await app.request(base + "/link?heading=dynamic%20heading", {}, env)
      ).json(),
    ).toEqual({ url: `${env.APP_ORIGIN}/app/d/${doc.id}#dynamic%20heading` });
    expect(
      (await app.request(base + "/link?comment=cmt_missing&heading=foo", {}, env))
        .status,
    ).toBe(400);
    expect(
      (await app.request(base + "/link?heading=" + "é".repeat(513), {}, env)).status,
    ).toBe(400);
    const other = await createDocument(
      env,
      actor,
      "Other",
      bytes("<h1>Other</h1>"),
      "private",
    );
    expect(
      (
        await app.request(
          base + `/headings?version=${other.current_version_id}`,
          {},
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(base + `/link?version=${other.current_version_id}`, {}, env))
        .status,
    ).toBe(404);
    expect(
      (await app.request(base + "/link?comment=cmt_missing", {}, env)).status,
    ).toBe(404);
  });
});
describe("Go label endpoints", () => {
  it("defaults disabled with exact Go feature error and allows real replacement when enabled", async () => {
    const { env, actor, app } = await fixture();
    const doc = await createDocument(env, actor, "Labels", bytes("labels"), "private"),
      base = `/v1/documents/${doc.id}/labels`;
    const disabled = await app.request(base, {}, env);
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({
      error: {
        code: "feature_disabled",
        message: "Document labels are temporarily disabled",
      },
    });
    expect((await app.request("/v1/documents?label=api", {}, env)).status).toBe(404);
    env.LABELS_ENABLED = "true";
    const replaced = await app.request(
      base,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels: [" API ", "ops", "api"] }),
      },
      env,
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ items: ["api", "ops"] });
    expect(await (await app.request(base, {}, env)).json()).toEqual({
      items: ["api", "ops"],
    });
    expect((await listDocuments(env, actor, "label:api,ops"))[0].labels).toEqual([
      "api",
      "ops",
    ]);
    expect(await listDocuments(env, actor, "label:api,missing")).toEqual([]);
    expect(
      documentList.parse(
        await (
          await app.request("/v1/documents?label=api", {}, env)
        )
          .json()
          .then((value) => z.object({ items: documentList }).parse(value).items),
      ),
    ).toHaveLength(1);
    expect(
      (
        await app.request(
          base,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: '{"labels":["invalid label"]}',
          },
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          base,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ labels: Array(21).fill("api") }),
          },
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      await (
        await app.request(
          base,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: '{"labels":null}',
          },
          env,
        )
      ).json(),
    ).toEqual({ items: [] });
  });
});

it("matches PostgreSQL18 reference lexemes, rank, and marked snippets", () => {
  const text =
    "running2 foo-bar cafe-naïve foo_bar https://example.com/path foo@example.com /tmp/file 1.2.3 -3.14 1e5";
  expect(lexemes(text).map((word) => [word.stem, word.position])).toEqual([
    ["running2", 1],
    ["foo-bar", 2],
    ["foo", 3],
    ["bar", 4],
    ["cafe-naïv", 5],
    ["cafe", 6],
    ["naïv", 7],
    ["foo", 8],
    ["bar", 9],
    ["example.com/path", 10],
    ["example.com", 11],
    ["/path", 12],
    ["foo@example.com", 13],
    ["/tmp/file", 14],
    ["1.2.3", 15],
    ["-3.14", 16],
    ["1e5", 17],
  ]);
  expect(
    matchDocument("Budget plan", "Planning notes.", searchTerms(["budget"]), [])?.rank,
  ).toBe(Math.fround(0.6079271));
  expect(
    matchDocument(
      "Q3 incident review",
      "The error budget for checkout was exceeded twice.",
      searchTerms(["incident", "twice"]),
      [],
    )?.rank,
  ).toBe(Math.fround(0.16362892));
  expect(
    matchDocument(
      "Title",
      "The runners ran running twice and are planning notes.",
      searchTerms(["run", "plan"]),
      [],
    )?.rank,
  ).toBe(Math.fround(0.17241628));
  expect(matchDocument("Title", text, searchTerms(["foo-bar"]), [])?.snippet).toBe(
    "running2 \x02foo\x03-\x02bar\x03 cafe-naïve \x02foo\x03_\x02bar\x03 https://example.com/path \x02foo@example.com\x03 /tmp/file",
  );
  expect(
    matchDocument(
      "Title",
      "foo@example.com a@b.com",
      searchTerms(["foo@example.com"]),
      [],
    )?.snippet,
  ).toBe("\x02foo@example.com\x03 a@b.com");
  expect(
    matchDocument(
      "Title",
      "https://example.com/path",
      searchTerms(["example.com/path"]),
      [],
    )?.snippet,
  ).toBe("\x02example.com\x03\x02/path\x03");
  expect(
    searchText(
      new Uint8Array([...bytes("<p>caf"), 0xe9, 32, 0xd3, 0xeb, ...bytes(" ok</p>")]),
    ),
  ).toBe("caf  ok");
  expect(searchText(bytes("<p>Replacement \ufffd text</p>"))).toBe(
    "Replacement \ufffd text",
  );
});
it("publishes source metadata with the winning version and protects label replacement", async () => {
  const { env, actor } = await fixture({ LABELS_ENABLED: "true" });
  const doc = await createDocument(
    env,
    actor,
    "Version text",
    bytes("<h1>Earlier</h1>"),
    "private",
  );
  const version = await createVersion(
    env,
    actor,
    doc.id,
    doc.current_version_id,
    "later",
    bytes("<h1>Later</h1><p>newlyindexable</p>"),
  );
  expect(
    (await listDocuments(env, actor, "newlyindexable"))[0].current_version_id,
  ).toBe(version.id);
  expect(await listDocuments(env, actor, "earlier")).toEqual([]);
  await replaceDocumentLabels(env, actor, doc.id, ["api"]);
  const other: Actor = {
    principal: await seedUser(env, "usr_label_other", "label@example.com"),
    credentialKind: "session",
  };
  await expect(
    replaceDocumentLabels(env, other, doc.id, ["spoofed"]),
  ).rejects.toMatchObject({ status: 403 });
  expect((await getDocument(env, actor, doc.id)).labels).toEqual(["api"]);
  await env.DB.prepare("UPDATE documents SET deleted_at=? WHERE id=?")
    .bind(new Date().toISOString(), doc.id)
    .run();
  await expect(replaceDocumentLabels(env, actor, doc.id, [])).rejects.toMatchObject({
    status: 403,
  });
  expect(
    (
      await env.DB.prepare("SELECT label FROM document_labels WHERE document_id=?")
        .bind(doc.id)
        .all()
    ).results,
  ).toEqual([{ label: "api" }]);
});

it("uses PG18 stored positions for phrases and exclusions, but raw positions for headlines", () => {
  const text = "filler ".repeat(17000) + "alpha beta";
  expect(matchDocument("Title", text, searchTerms(["alpha beta"]), [])).toBeUndefined();
  expect(
    matchDocument("Title", text, searchTerms(["alpha"]), searchTerms(["alpha beta"])),
  ).toBeDefined();
  expect(
    matchDocument("Title", text, searchTerms(["alpha"]), searchTerms(["beta"])),
  ).toBeUndefined();
  expect(
    matchDocument("Title", text, searchTerms(["alpha", "beta"]), [])?.snippet,
  ).toBe(
    "filler filler filler filler filler filler filler filler filler filler filler alpha beta",
  );
  const repeated = "alpha ".repeat(300) + "beta";
  expect(
    storedLexemes(lexemes(repeated)).filter((word) => word.stem === "alpha"),
  ).toHaveLength(255);
  expect(
    matchDocument("Title", repeated, searchTerms(["alpha beta"]), []),
  ).toBeUndefined();
});

it("builds snippets only for the selected 25 results", async () => {
  const { env, actor } = await fixture();
  const doc = await createDocument(env, actor, "needle", bytes("needle"), "private");
  await env.DB.batch(
    Array.from({ length: 25 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO documents(id,title,owner_user_id,current_version_id,updated_at) VALUES (?,?,?,?,?)",
      ).bind(
        `doc_snippet_${i}`,
        "needle",
        actor.principal.id,
        doc.current_version_id,
        "2026-10-13T00:00:00Z",
      ),
    ),
  );
  const snippets = vi.spyOn(searchTextService, "documentSnippet");
  try {
    expect(await listDocuments(env, actor, "needle")).toHaveLength(25);
    expect(snippets).toHaveBeenCalledTimes(25);
  } finally {
    snippets.mockRestore();
  }
});

it("matches PG18 saturated-vector rank while headlining all raw occurrences", () => {
  const match = matchDocument(
    "Title",
    "needle ".repeat(37449),
    searchTerms(["needle"]),
    [],
  );
  expect(match?.rank).toBeCloseTo(0.09976207, 7);
  expect(match?.snippet).toBe(Array(24).fill("\x02needle\x03").join(" "));
  expect(storedLexemes(lexemes("alpha ".repeat(300)), 256)).toHaveLength(256);
});
