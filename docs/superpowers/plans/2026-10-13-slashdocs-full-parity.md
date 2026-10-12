# SlashDocs full parity implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Complete each task with independent review and test evidence before marking it done.

**Goal:** Match the fork's upstream Go API, MCP, frontend and CLI behavior on Cloudflare.

**Architecture:** Retain Hono/D1/R2 and isolated HTML rendering. Add a SQLite Durable Object for document serialization, event replay/presence and durable integration delivery where required. Keep shared contracts and configurable external providers at explicit boundaries.

**Tech stack:** Bun 1.4, TypeScript/Hono, Cloudflare Workers/D1/R2/SQLite Durable Objects, retained React and Go CLI.

**Spec:** [Parity acceptance and ledger](../../cloudflare/PARITY.md), plus the checked-in Go handlers, repository implementations and tests.

## Global constraints

- Preserve original Go deployment and wire-compatible frontend/CLI contracts.
- Actual credentials, origins, allowlists and resource IDs remain outside Git.
- Keep app and untrusted content on isolated origins.
- Do not announce full parity while any required endpoint/tool returns a placeholder or unavailable implementation.
- Configurable integrations may report the upstream unconfigured response until provider credentials are installed.

## Review focus

- Concurrent folder moves cannot create cycles or exceed depth 15.
- Access/credential revocation closes live streams and prevents queued writes/delivery.
- Service identities retain their type through ownership, comments and inherited grants.
- Notification retries/coalescing do not duplicate messages or reveal missing documents.
- Search parser partial input, dates/timezones and authorization match upstream results.

### Task 1: Folders and inherited access

Files: `migrations/0002_folders.sql`, `services/folders.ts`, `routes/folders.ts`, `services/permissions.ts`, folder tests.

Consumes existing actor, D1 and document access contracts. Produces `folderAccessChain`, `requireFolder`, folder routes and two-bind viewer/editor predicates including inherited grants.

- [ ] Add failing Go-equivalent folder/move/inheritance/cycle/deletion tests.
- [ ] Implement atomic tree constraints, workspace visibility, folder grants and DTOs.
- [ ] Integrate documents, pins and featured. Run real D1 and CLI folder tests.
- [ ] Independent review, resolve findings, commit.

### Task 2: Document state and realtime

Files: `migrations/0003_state.sql`, `services/state.ts`, `routes/state.ts`, `realtime/document-realtime.ts`, runtime tests.

Produces `stateRoutes`, `DocumentRealtime`, `announceDocumentEvent(env, actor, documentId, kind)` for document/comment mutations.

- [ ] Add failing concurrent revision, input-limit, SSE replay/presence/revocation tests.
- [ ] Implement KV normalization and serialized revisions. Preserve bridge inverse-PATCH undo/redo.
- [ ] Wire SQLite DO configuration, mutation announcements and retained frontend streams.
- [ ] Independent review, resolve findings, commit.

### Task 3: Identity and OIDC

Files: `migrations/0004_identity.sql`, `auth/oidc.ts`, auth routes/middleware, `routes/service-accounts.ts`, identity tests.

Produces polymorphic Actor authentication, `serviceAccountRoutes`, provider discovery/claims validation and `revalidateActor` for stream/delivery checks.

- [ ] Add failing generic OIDC, split-horizon, account/key disable/revoke and ownership transfer tests.
- [ ] Implement backing principal rows, hashed keys and atomic transfers.
- [ ] Integrate polymorphic ownership/author/grant DTOs and human-only user search.
- [ ] Independent review, resolve findings, commit.

### Task 4: MCP and OAuth

Files: new MCP routes/tool adapters, OAuth storage migration and tests.

Consumes canonical HTTP handlers and actor validation. Produces the upstream tool inventory, streamable MCP endpoint, protected-resource metadata, registration, consent and PKCE token exchange.

- [ ] Extract upstream tool/argument/response fixtures and OAuth negative cases.
- [ ] Implement adapters to canonical handlers rather than duplicating mutations.
- [ ] Test every tool and consent/replay/redirect/scope failure in workerd.
- [ ] Independent review, resolve findings, commit.

### Task 5: Search, mentions, labels and links

Files: new search/HTML text/link services, metadata migration, document/comment integrations and tests.

- [ ] Translate upstream search/date and mention/link validation fixtures.
- [ ] Implement indexed source text, operators/date bounds, labels, validated principal mentions, headings and deep links.
- [ ] Test authorization, partial queries, timezones, version scope and escaped content.
- [ ] Independent review, resolve findings, commit.

### Task 6: Notifications and external integrations

Files: provider adapters, notification persistence/delivery, GitHub/Google Groups routes and migrations/tests.

- [ ] Translate upstream preference, recipient, retry/coalescing, repository-access and group-resolution tests.
- [ ] Implement durable notification delivery, configurable Slack, GitHub OAuth/token encryption/raw access and Google Directory verification.
- [ ] Test external HTTP through provider fixtures; preserve revocation and privacy checks.
- [ ] Independent review, resolve findings, commit.

### Task 7: Integration and strict parity gate

Files: app entrypoint/config, setup/deploy tooling, frontend capabilities, parity tests, documentation.

- [ ] Compare every registered route and MCP tool against the checked-in Go implementation.
- [ ] Remove foundation placeholders after their replacements pass.
- [ ] Run all Workers/frontend/Go CI, clean builds, real browser and CLI flows.
- [ ] Whole-branch review, fix/re-review findings, scan private values, push and verify deployment.
