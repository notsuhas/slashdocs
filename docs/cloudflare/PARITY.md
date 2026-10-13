# Parity acceptance

The reference is the Go server, React reader and CLI at upstream commit `6ccc967e6f5eab522ba60a1ab64da7f3dcccc614`, the fork's current source baseline. Full parity means matching its observable behavior and configurable integrations. It does not mean returning successful placeholders, hiding unsupported controls, or replacing writes with local browser state.

## Required checks

- Inventory every registered HTTP route, MCP tool and OAuth flow against the Go source.
- Check response shapes, status/error codes, ownership, inherited roles, disabled identities, revocation and conflicting writes.
- Run D1/R2 behavior tests and bundled workerd tests. Mock only external provider HTTP boundaries.
- Check realtime replay, disconnect/reconnect, presence expiry and credential/access revocation while a stream is open.
- Verify the retained frontend and CLI with capabilities enabled only for implemented behavior.
- Review each implementation independently and resolve blocking findings. Run the original Go CI as well as Cloudflare CI.
- Keep credentials and instance-specific values outside Git. External integrations require their normal provider configuration, just as upstream does.

## Work ledger

| Area                                                          | Implementation | Independent review                                                  | Runtime/contract proof                                                                      |
| ------------------------------------------------------------- | -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Folders, inherited sharing, moves, pins and featured          | Implemented    | Sharing rounds 1–3 resolved; restored grant IDs reviewed            | Real D1 concurrency, Unicode, revocation and query-budget tests                             |
| KV mutations, undo/redo, SSE and presence                     | Implemented    | Heartbeat, fanout and replay fixes independently reviewed           | Actual workerd replay, 32-event overflow, 64-principal fanout, disconnect cleanup           |
| Generic OIDC, service accounts, keys and ownership transfers  | Implemented    | Identity review clean; configured-provider alias regression covered | Real D1 claim/transfer races and signed OIDC fixtures                                       |
| MCP tools and OAuth consent/PKCE                              | Implemented    | Auth/transport reviewed                                             | All 49 exact upstream tools exercised through actual workerd                                |
| Search operators/dates/full text and labels                   | Implemented    | Search runtime and metadata fixes independently reviewed            | Go grammar fixtures, PostgreSQL 18 golden rank/snippet cases, SQLite DO execution           |
| Structured mentions, headings and deep links                  | Implemented    | Metadata review fixes resolved                                      | Real D1/R2 Unicode, publication, placement and notification tests                           |
| Notification preferences, access requests and Slack delivery  | Implemented    | Earliest-alarm and concurrent-wake fixes independently reviewed     | Real D1/DO queue, coalescing, retries, current access and continuous-wake tests             |
| GitHub connection/raw content/author access and Google Groups | Implemented    | Runtime/sharing reviews resolved                                    | Provider HTTP boundary mocks, signed JWT, customer-change and stale-write tests             |
| Frontend, deployment configuration and shared contracts       | Implemented    | Deployment/containment fixes independently reviewed                 | Go CLI create/pull/push, browser rendering/live comments/Swagger, HTTP/MCP inventory guards |

This ledger records behavior against the pinned source baseline, not a promise of byte-identical PostgreSQL internals. See [metadata contract](parity-metadata-contract.md) for specialized lexer, dictionary, locale and malformed-HTML differences that remain outside the golden fixture coverage. Existing Go-issued MCP credentials require new Cloudflare registration. External OIDC, GitHub, Google Groups and Slack integrations require provider configuration.

Search and bounded source backfills run through the private `DocumentSearch` SQLite Durable Object binding, using its default CPU allowance. App and renderer Workers remain on the free plan. Free request, D1, Durable Object and R2 quotas still apply; R2 can bill overages, so deployment is not a blanket guarantee of a zero bill at arbitrary traffic or storage.

## Schema decisions

Existing user-referencing D1 foreign keys remain intact. Service-account principals receive a backing identity row with provider `service_account`, their service-account ID, an empty email and their display name. Human user search excludes these rows; public DTOs retain the `service_account` principal type. Service-account metadata, owners and keys have separate tables. This permits polymorphic document owners/authors without replacing every existing foreign key during the port. Tests must reject a disabled or revoked service identity.

Folder ownership is exact-resource ownership and never inherited. Grants inherit down the folder tree. SQLite triggers check depth and cycles in the same write that changes the tree, including concurrent reparenting. The renderer remains isolated from app credentials.

Document revisions are shared by KV, document, comment and presence events. A SQLite Durable Object serializes document events and streams replay/live updates; D1 remains the durable document-state store. Upstream state and stream limits are the acceptance values. Runtime availability and free-tier quotas are recorded separately from feature parity.

## Verification record

The final Workers run, including Wrangler migration deployment regressions, passed 211 tests. The added deployment/configuration checks passed their focused 14-test run, including the new containment and provider-transition regressions. Worker typecheck, lint, formatting, frontend build and both Wrangler dry runs passed. The retained frontend passed 102 tests, lint and formatting; Go API and CLI suites passed. Browser checks verified uploaded rendering, live comments between two tabs and authenticated Swagger. The unchanged CLI created, pulled and pushed a document.

Independent review findings in sharing, identity, metadata, realtime, notifications and deployment have been resolved. Atomic empty-secret replacement was verified against an isolated Cloudflare Worker; the temporary probe resources were removed. These checks are bounded evidence against the pinned baseline; provider configuration and account quotas remain installation concerns.

The production deployment from `553c58b` applied all ten D1 migrations and backfilled existing current-version metadata. Live checks passed for authentication, publication, indexed search, headings, folders and render capabilities. The GPS document rendered in the browser and its SSE endpoint returned stream data. Temporary verification content and credentials, maintenance Workers and isolated probes were removed. GitHub host checks were still running at handoff; local validation is the evidence above.
