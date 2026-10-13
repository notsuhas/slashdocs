# Cloudflare implementation

Cloudflare is an optional deployment target. The original Go server, Docker/Helm deployment, React reader, browser bridge and Go CLI remain available. The Worker backend targets the same registered HTTP and MCP contracts; implementation and review status is tracked in [PARITY.md](PARITY.md).

## Module boundaries

| Module                                      | Responsibility                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `workers/app/src/auth` and `routes/auth.ts` | Verified Google/OIDC identities, admission policy, browser sessions, CLI PKCE and credential revocation |
| `workers/app/src/services`                  | Document access, immutable versions, upload compensation, comments and reactions                        |
| `workers/app/src/routes`                    | HTTP validation and existing frontend/CLI response shapes                                               |
| `workers/render`                            | Signature verification and isolated HTML rendering with the retained annotation bridge                  |
| `workers/shared`                            | Response contracts, IDs, errors and render capabilities                                                 |
| `workers/scripts`                           | Asset/CLI builds, private instance configuration, provisioning and deployment                           |
| `workers/tests`                             | API behavior, access rules, concurrent writes, quota bounds and runtime integration                     |

D1 stores users, sessions, grants, document/version metadata and comments. R2 stores immutable uploaded HTML. Publishing a new version checks the requested base version and current editor access in the committing statement; conflicting publication cannot overwrite another writer's version. Failed publications retain a cleanup record until their objects are removed.

The app issues short-lived EdDSA capabilities scoped to one document, version, object and audience. The renderer receives only the verification public key and R2 binding. It strips the capability from frame history before uploaded HTML executes and uses a separate sandboxed frame for that content. The app never executes source downloads. Use separate app/render hostnames; workers.dev is supported for the renderer.

## Backend behavior

The app Worker implements Google and generic OIDC sessions, CLI PKCE, service accounts and transfers, document publication, nested folders, inherited sharing, labels, English full-text search, structured comments and reactions, persistent document state, SSE replay and presence. MCP exposes the 49 upstream tools through the same authenticated handlers. GitHub, Google Groups and Slack use configurable provider credentials; tests mock their external HTTP boundaries.

D1 stores metadata, permissions, state, replay events and notification outboxes. SQLite Durable Objects serialize document events and delivery alarms, and run full-text search and bounded source backfills under their CPU allowance. Consumers that stop reading are reclaimed after missed heartbeat demand; overflowing live subscribers reconnect and replay persisted event IDs. The renderer receives no app credentials.

Search and comment storage differences are recorded in their contract documents. Free-tier CPU and account-wide usage limits are operational constraints independent of API coverage.

## Maintaining both deployment targets

Keep existing frontend and CLI wire contracts compatible. The Cloudflare response types currently mirror the frontend contract; changes to shared API shapes need updates and tests in both server implementations. Keep capability fields optional so existing Go deployments retain their behavior. CI compares the registered Go MCP tool names, descriptions, schemas and annotations against the Worker contract. A Worker test also checks every authenticated Go HTTP endpoint is registered. Upstream API changes trigger both CI targets.

The dedicated Cloudflare workflow installs the locked Bun workspace, checks Workers and the retained frontend, runs Go CLI tests, builds static assets/four CLI binaries, and bundles both Workers without credentials. The original Go CI remains independent. Binding tests use actual Miniflare D1/R2; most route tests invoke handlers from the test host, while runtime integration tests execute bundled handlers inside workerd. Signed Google fixtures do not replace a live OAuth verification.

Before changing renderer security, verify app-origin source downloads remain inert, tokens cannot cross document/version/audience boundaries, and app credentials never enter content. Before changing list APIs, keep D1 statements bounded under the Workers Free request limit. Local tests and successful bundles do not establish a production CPU or account-wide storage budget.
