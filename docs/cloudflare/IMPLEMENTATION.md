# Migration progress

## Scope and decisions

The approved target is a standalone SlashDocs fork, keeping its name, React UI, HTML model and local Go CLI. The backend is TypeScript/Hono with D1 metadata and immutable R2 source objects. App and content Workers use separate hostnames. All actual configuration is outside the repository; tracked examples use generic domains and placeholder keys.

Phase 1 is the publish/review foundation. Subsequent milestones retain the assessed goal of broad SlashDocs parity, including folders, MCP, document state and Durable Object realtime. No admin console is included in upstream or this foundation.

## Ownership

- Integration: root agent owns schema/contracts, Worker entrypoint, frontend capability gating, private-config tooling, CLI assets and end-to-end checks.
- Authentication subagent: Google/OAuth, CLI PKCE, admission policy, cookies and credentials.
- Documents subagent: immutable objects, CAS versions, direct grants and access.
- Review/render subagent: comments, moderation/reactions and isolated signed rendering.

## Progress

- GitHub fork created; independent `cloudflare` branch.
- Backend module implementations complete with real D1/R2 tests.
- Local auth uses signed Google fixtures; live login awaits OAuth credentials.
- Deployment tools provision resources by name and generate secrets/config only outside Git.
- Integration verification and whole-branch review in progress.

## Acceptance

The foundation must pass Workers typecheck, lint/format, real D1/R2 tests, frontend build/tests, unmodified CLI create/pull/push against the local backend, and an actual browser anchored-comment flow. Before deployment verify source HTML cannot execute on app origin, credentials never enter render, and private config is absent from Git.
