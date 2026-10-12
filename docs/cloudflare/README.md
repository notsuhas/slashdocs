# Cloudflare foundation

This branch ports SlashDocs' server to TypeScript/Hono on Cloudflare Workers. It retains the React frontend, browser annotation bridge and Go CLI. The original Go server remains available; this is a separate deployment target.

The first release implements Google browser/CLI authentication, configurable exact-email and domain admission, document publishing, immutable versions with stale-write conflicts, direct sharing, anchored comments/replies/reactions, source download and isolated rendering. The UI uses visibility-aware polling for updates.

Not yet ported: nested folders/inherited grants, full-text search, service accounts, generic OIDC, remote MCP, structured mentions, notification delivery, GitHub/Google Groups integrations, shared document state and realtime presence. Search currently matches document titles. Direct sharing is owner-managed in this foundation. Unsupported controls are capability-gated where integrated; do not describe this branch as full upstream parity.

## Private configuration

Copy `workers/instance.example.json` to a path **outside the repository**, such as `~/.config/slashdocs-cloudflare/instance.json`, and restrict it to your user. Never put a real instance config, credential, hostname or email allowlist in Git. Tools reject real instance configuration inside the checkout. Only `.example` files are tracked.

Configure your Cloudflare account/scoped API token, two separate HTTPS hostnames, allowed emails/domains and a Google OAuth Web client. Google must register `<app-origin>/v1/auth/google/callback`. Blank admission configuration denies login; matching one configured exact email OR domain allows verified Google identities. Do not allow an entire public email-provider domain to admit a single address.

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

Provisioning is repeatable by resource name and refuses a conflicting stored database ID. It creates dedicated D1/R2 resources and generates render signing keys. Deployment requires configured Google credentials. The setup does not configure Google OAuth for you, buy a domain or opt into a Workers paid subscription.

D1 and R2 free allowances are account-wide. R2 Standard bills overages. The foundation defaults to a 1 MiB HTML cap; it does not yet implement account-wide storage/operation budget enforcement. Monitor usage and cap retention before opening a large installation. Local tests do not prove production CPU fits Workers Free's 10 ms execution budget.

## Local verification

Worker tests use actual Miniflare D1 and R2 and signed Google fixtures. They cover PKCE and state replay, admission policy, cookie/Origin rules, concurrent same-base version publication, grant revocation while uploading, failed publication cleanup, scoped comments, signed rendering and untrusted attribute escaping. Google tests mock the external token/JWKS endpoint; live Google login still needs real credentials.

`workers/wrangler.*.example.jsonc` are local templates. For simultaneous local Workers, use different hostnames such as `localhost` and `127.0.0.1` as well as separate ports. Keep both on one shared persistence directory for R2. Provide generated development signing keys through external `.dev.vars` files beside private configs. Never use a same-hostname render origin as a production shortcut.

The deployment scripts build the existing CLI for macOS/Linux arm64/amd64 and publish its installer/skill as static assets. CLI self-update signing/release automation remains to be configured separately.
