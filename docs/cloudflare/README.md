# Cloudflare deployment

This branch ports SlashDocs' server to TypeScript/Hono on Cloudflare Workers. It retains the React frontend, browser annotation bridge and Go CLI. The original Go server remains available; this is a separate deployment target.

The Worker backend implements the upstream document, folder, sharing, comment,
state, service-account, OIDC, MCP and integration APIs. Nested folder grants,
structured mentions, full-text search, labels, notifications and SSE presence use
D1 and SQLite Durable Objects. All 49 MCP tools delegate to the same HTTP handlers.
Provider integrations remain optional and require their normal credentials.

The compatibility reference and review ledger are in [PARITY.md](PARITY.md).
Search implements PostgreSQL English stemming, query operators, ranking and
snippets, with recorded PostgreSQL comparison fixtures. Specialized lexer and
locale behavior and storage concurrency differences are described in the
[metadata](parity-metadata-contract.md) and [comment](comments-parity.md) contracts.

## Private configuration

Copy `workers/instance.example.json` to a path **outside the repository**, such as `~/.config/slashdocs-cloudflare/instance.json`, and restrict it to your user. Never put a real instance config, credential, hostname or email allowlist in Git. Tools reject real instance configuration inside the checkout. Only `.example` files are tracked.

Configure your Cloudflare account/scoped API token, two separate HTTPS hostnames, allowed emails/domains and one login provider. Use `googleClientId`/`googleClientSecret` for Google or `oidcIssuer`/`oidcClientId`/`oidcClientSecret` for generic OIDC. Optional `oidcInternalIssuer` rebases discovery, token and JWKS traffic; `oidcProviderName` controls the login label. Register `<app-origin>/v1/auth/google/callback` for Google or `<app-origin>/v1/auth/oidc/callback` for OIDC. Blank admission configuration denies login; matching one configured exact email OR domain allows verified Google identities. Do not allow an entire public email-provider domain to admit a single address.

Optional integration configuration uses `githubClientId`/`githubClientSecret`, `slackBotToken`, and `googleGroupsEnabled`/`googleGroupsCustomerId`/`googleGroupsServiceAccount`. The group credential is a JSON string; its optional `subject` enables domain delegation. `labelsEnabled` defaults to false, matching upstream.

The app Worker owns D1 and a private R2 bucket. The separate render Worker receives R2 and only a render verification public key. No session, Google secret or app signing private key enters uploaded HTML or the render Worker. Application cookies are host-only. Scoped render capabilities expire; protected responses are private/no-store.

## Commands

Use Bun 1.4 and the Go toolchain required by the upstream `go.mod` for CLI builds.

```sh
bun install --frozen-lockfile
bun run typecheck:workers
bun run test:workers
bun run lint:workers
bun run format:check:workers
bun run build:cloudflare

# All instance values, resource IDs and generated keys remain outside Git.
bun workers/scripts/provision.ts /absolute/private/instance.json
bun workers/scripts/configure.ts /absolute/private/instance.json
bun workers/scripts/deploy.ts /absolute/private/instance.json
```

Provisioning is repeatable by resource name and refuses a conflicting stored database ID. It creates dedicated D1/R2 resources and generates render signing keys. Deployment requires one complete Google or generic OIDC provider. The setup does not configure Google OAuth for you, buy a domain or opt into a Workers paid subscription.

Hourly orphan cleanup, expired OAuth cleanup and incremental source indexing are opt-in: set `cleanupCron: true` in the private instance configuration when the account has a free cron slot. The default uses no cron slots. Without the schedule, object cleanup after failed publications remains pending and those objects consume storage until cleanup runs.

The renderer can use its free `https://<renderWorkerName>.<account-subdomain>.workers.dev` address instead of a custom domain. Set that address as `renderOrigin` in private configuration; configuration enables the renderer's workers.dev route and creates no custom-domain route for it. This avoids inheriting custom-zone browser challenges and parent-domain cookies. The app can still use its custom domain. Signed capabilities remain mandatory. If a custom renderer domain returns an empty edge 403 before reaching the Worker, check the zone's security settings rather than weakening token validation.

D1 and R2 free allowances are account-wide. R2 Standard bills overages. The API defaults to the upstream 50 MiB HTML limit; private `maxHTMLBytes` can lower it. Account-wide storage/operation budget enforcement is not implemented. Monitor usage and cap retention before opening a large installation. Local tests do not prove production CPU fits Workers Free's 10 ms execution budget.

## Local verification

Worker tests use actual Miniflare D1 and R2 and signed Google fixtures. They cover PKCE and state replay, admission policy, cookie/Origin rules, concurrent same-base version publication, grant revocation while uploading, failed publication cleanup, scoped comments, signed rendering and untrusted attribute escaping. Google tests mock the external token/JWKS endpoint; live Google login still needs real credentials.

`workers/wrangler.*.example.jsonc` are local templates. For simultaneous local Workers, use different hostnames such as `localhost` and `127.0.0.1` as well as separate ports. Keep both on one shared persistence directory for R2. Provide generated development signing keys through external `.dev.vars` files beside private configs. Never use a same-hostname render origin as a production shortcut.

An isolated loopback browser/CLI check is available after building:

```sh
SLASHDOCS_LOCAL_SMOKE=1 bun x tsx workers/scripts/local-smoke.ts
```

It seeds generic temporary identities, exercises the unchanged Go CLI, and serves a local browser fixture. Its fixture sign-in route is never part of either deployed Worker.

The deployment scripts build the existing CLI for macOS/Linux arm64/amd64 and publish its installer/skill as static assets. CLI self-update signing/release automation remains separate from Worker deployment.

## GitHub deployment

The `Cloudflare` workflow validates pull requests and builds both Workers without credentials. Production deployment is opt-in: set repository variable `CLOUDFLARE_DEPLOY_ENABLED` to `true`, create a `production` environment allowing only the `main` branch, and store the complete provisioned private instance JSON as its `SLASHDOCS_INSTANCE_JSON` secret. Use a dedicated scoped Cloudflare token in that JSON; the global API key is never used by the workflow. The required permissions are Workers Scripts Write, D1 Write, Workers R2 Storage Write and Account Settings Read for the selected account, plus Workers Routes Write and Zone Read for the app's zone.

After merging to `main`, CI must pass before the production job applies migrations, deploys the isolated renderer, then uploads the app code, configuration and complete secret set together with Wrangler `--secrets-file`, checks readiness, and backfills old current-version search metadata in batches of twenty. Absent optional credentials are uploaded as empty secrets to reset previous values in the same app version. Omitted secrets would be preserved, so deployment never deletes or updates secrets on the active version separately. The temporary authenticated backfill Worker forwards indexing to the app’s private SQLite Durable Object binding and is removed afterward. Manual dispatch from `main` follows the same checks. Pull requests and other branches cannot deploy. An optional repository variable `SLASHDOCS_LABELS_ENABLED` set to `true` or `false` overrides only `labelsEnabled` from the private deployment secret; when unset, that secret remains authoritative. Deployments are serialized and running production deployments are not canceled by newer commits. The workflow restores private files outside the checkout, masks configuration values, and removes those files afterward. Keep signing keys and resource IDs stable in the secret; CI provisioning must not generate a different key pair on each release. Renew a time-limited deployment token before it expires.

To set the environment secret from an existing private file without putting its contents in shell arguments:

```sh
gh secret set SLASHDOCS_INSTANCE_JSON --env production --repo OWNER/slashdocs < /absolute/private/instance.json
gh variable set CLOUDFLARE_DEPLOY_ENABLED --repo OWNER/slashdocs --body true
```

The workflow becomes available after its code reaches the relevant branch. This setup keeps the original Go CI and deployment target available; it does not merge or publish a pull request automatically.

## Admin statistics

Set `ADMIN_USERS` on the app Worker to a comma-separated list of admin email addresses
(e.g. `you@example.com,other@example.com`). Those users must still satisfy the login
policy. Unset/empty denies everyone; bots cannot be admins. Open **Admin statistics**
in the account menu or `/app/admin`. Authorization is enforced by `/v1/admin/stats`.
Apply D1 migrations before deploying this version. For generated deployments, set
`ADMIN_USERS` as an app Worker secret so regenerating configuration preserves it;
for local development, use `.dev.vars` or the example Wrangler `vars` block.

The dashboard reports signed-up human accounts, active humans over 24 hours/7 days/30 days,
unexpired browser sessions, retained documents/versions, stored HTML bytes, comments,
enabled bots, and daily authenticated API request totals over 30 UTC days. Logged-in
means a valid session, not current online presence. Activity starts with this deployment;
pre-tracking dates display a dash. Usage counts REST requests and internal API dispatches made by MCP tools, including
bots, automatic document refreshes, and failed authorized operations. It excludes
dashboard requests, presence heartbeats, event streams, and 429 rejections, and does
not represent Cloudflare billing or anonymous render traffic. Counter writes use
`waitUntil`; failures are logged without failing the user operation. Daily activity
records are retained for 31 UTC calendar days and pruned on the first API operation
each UTC day. Enable `cleanupCron` for hourly cleanup, including during periods with
no API traffic. Expired sessions are removed by both cleanup paths. Tracking
initialization persists independently of traffic and retention.
Use an OIDC provider that verifies email ownership before granting email-based admin
access; if it omits `email_verified`, it must enforce that guarantee itself.
Deleted documents and their versions/comments are excluded; HTML bytes exclude orphan R2 objects,
database storage, and infrastructure overhead. Counters contain aggregate counts, not document contents.
