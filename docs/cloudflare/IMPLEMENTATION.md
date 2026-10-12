# Cloudflare implementation

Cloudflare is an optional deployment target. The original Go server, Docker/Helm deployment, React reader, browser bridge, and Go CLI remain available. This first milestone implements the publish/review foundation; it does not provide complete upstream feature parity.

## Module boundaries

| Module                                      | Responsibility                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `workers/app/src/auth` and `routes/auth.ts` | Verified Google identities, admission policy, browser sessions, CLI PKCE and credential revocation |
| `workers/app/src/services`                  | Document access, immutable versions, upload compensation, comments and reactions                   |
| `workers/app/src/routes`                    | HTTP validation and existing frontend/CLI response shapes                                          |
| `workers/render`                            | Signature verification and isolated HTML rendering with the retained annotation bridge             |
| `workers/shared`                            | Response contracts, IDs, errors and render capabilities                                            |
| `workers/scripts`                           | Asset/CLI builds, private instance configuration, provisioning and deployment                      |
| `workers/tests`                             | API behavior, access rules, concurrent writes, quota bounds and runtime integration                |

D1 stores users, sessions, grants, document/version metadata and comments. R2 stores immutable uploaded HTML. Publishing a new version checks the requested base version and current editor access in the committing statement; conflicting publication cannot overwrite another writer's version. Failed publications retain a cleanup record until their objects are removed.

The app issues short-lived EdDSA capabilities scoped to one document, version, object and audience. The renderer receives only the verification public key and R2 binding. It strips the capability from frame history before uploaded HTML executes and uses a separate sandboxed frame for that content. The app never executes source downloads. Use separate app/render hostnames; workers.dev is supported for the renderer.

## Supported behavior

- Google web login with verified exact-email/domain admission, host-only sessions and Origin checks.
- Go CLI login via PKCE, credential listing/revocation, create/pull/push and source downloads.
- Documents, immutable versions, direct user/anyone grants, owner-managed sharing, pins and title search.
- Anchored comments, replies, resolution and reactions through the retained browser bridge.
- Visibility-aware polling. Unsupported frontend features are hidden through optional capabilities; absent capabilities preserve the original Go server's behavior.

## Deferred behavior

Nested folders and inherited grants, full-text/operator search, service accounts, generic OIDC, remote MCP, structured mentions, notifications, GitHub/Google Groups integration, document-state writes/undo and realtime presence are deferred. Document-state reads return the hydration shape expected by the bridge. Deferred APIs return explicit unavailable responses rather than pretending a write succeeded.

There is no admin console in this foundation. Keep deployment-specific identities, credentials, origins and resource IDs outside the repository. See [setup and verification](README.md) for private configuration and operational limits.

## Maintaining both deployment targets

Keep existing frontend and CLI wire contracts compatible. The Cloudflare response types currently mirror the frontend contract; changes to shared API shapes need updates and tests in both server implementations. Keep capability fields optional so existing Go deployments retain their behavior. Contract extraction/generation is a future maintenance improvement, not a dependency of this milestone.

The dedicated Cloudflare workflow installs the locked Bun workspace, checks Workers and the retained frontend, runs Go CLI tests, builds static assets/four CLI binaries, and bundles both Workers without credentials. The original Go CI remains independent. Binding tests use actual Miniflare D1/R2; most route tests invoke handlers from the test host, while runtime integration tests execute bundled handlers inside workerd. Signed Google fixtures do not replace a live OAuth verification.

Before changing renderer security, verify app-origin source downloads remain inert, tokens cannot cross document/version/audience boundaries, and app credentials never enter content. Before changing list APIs, keep D1 statements bounded under the Workers Free request limit. Local tests and successful bundles do not establish a production CPU or account-wide storage budget.
