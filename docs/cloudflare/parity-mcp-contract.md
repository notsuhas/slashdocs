# Cloudflare MCP contract

Baseline: `6ccc967`, as recorded in `PARITY.md`. The 49 definitions in `workers/app/src/mcp/tools.json` were extracted by registering the upstream Go tools with `NewMCPServer`, collecting `ListTools()[name].Tool`, sorting by name, and JSON encoding. Descriptions, input schemas, defaults, enum values, required fields, and annotations are preserved. `guidelines.json` contains the upstream shared guideline pages and aliases.

## Integration

`createMCPRoutes(dispatch)` returns a `Hono<AppEnv>` with the routes below. Its callback is `(env: Env, actor: Actor, request: Request) => Promise<Response>`. Each tool constructs a fresh Request targeting a canonical `/v1` handler, without identity headers. The app injects its verified actor through a private WeakMap. The public REST authenticator rejects MCP bearer tokens.

The transport is stateless and returns JSON. POST requires `Accept: application/json, text/event-stream` and JSON content type. It accepts `initialize`, `ping`, `tools/list`, `tools/call`, and notifications (202 with an empty body). GET streaming and DELETE sessions are disabled. Parse, invalid-request, invalid-params, method-not-found, and internal failures use JSON-RPC errors. Tool validation and canonical HTTP failures use `isError`, retaining the complete structured API error envelope. Successful JSON results carry both text and structured content; raw HTML and guideline results carry text.

MCP accepts only human OAuth `slashdocs_mcp_` tokens and native `slashdocs_sa_` / legacy `aidocs_sa_` service-account keys. CLI tokens, cookies alone, disabled accounts, revoked keys, expired tokens, and wrong audiences/scopes are rejected. Hostile browser origins are rejected before authentication. Unauthorized responses advertise the protected-resource metadata URL.

## OAuth routes and persistence

- `/.well-known/oauth-protected-resource` and `/mcp` suffix: resource URL, authorization server, header bearer support, and `mcp` scope.
- `/.well-known/oauth-authorization-server` and `/mcp` suffix: code/query flow, authorization-code grant, public clients, S256, and `mcp` scope.
- POST `/oauth/register`: dynamic public-client registration; HTTPS, loopback HTTP, and private-use app callbacks; no credentials or fragments. Registration tolerates a co-requested refresh-token grant but advertises authorization-code only and issues no refresh tokens. Redirect lists, names and callback lengths have upstream bounds.
- GET `/oauth/authorize`: authenticated human consent with escaped client name, callback, user identity, and a warning that the name is unverified.
- POST `/oauth/authorize`: same-origin consent, user/request-bound single-use nonce, registered redirect validation, response type, resource audience, S256 challenge, and default/required `mcp` scope. Cancel returns `access_denied` plus state to the already validated callback.
- POST `/oauth/token`: form-encoded authorization-code exchange, exact client/callback/resource binding, S256 verifier, five-minute expiry, atomic single-use consumption. A failed binding/PKCE check consumes the code, as upstream does. Access tokens last one hour.

Migration `0007_mcp.sql` owns four tables: `mcp_clients`, `mcp_consent`, `mcp_codes`, and `mcp_tokens`. Client registrations live for one year. Consent nonces, codes, and access tokens are stored as SHA-256 hashes; raw values are returned only to their recipient. Human actor `credentialId` is `mcp_tokens.token_hash`, allowing the trusted Durable Object gateway to revalidate `user_id`, `resource`, `scope`, and `expires_at`. Service-account actor `credentialId` is its key ID.

The Cloudflare implementation persists opaque client and access tokens in D1 rather than Go's signed stateless IDs/tokens. Tokens are transport-specific and scoped to this deployment. Imported Go signed credentials are not a migration path; clients register and authorize against the Cloudflare deployment.

Consent additionally binds a nonce to the exact authenticated user and validated authorization fields. This prevents consent replay and parameter replacement while retaining upstream authorization-code and scope behavior.

## Tool inventory

Every definition below has an adapter. Tools delegate canonical HTTP validation, permission checks, writes, and response shape. Creating/updating HTML uses multipart `file=document.html`. Fetching current HTML and moving a document to root first read canonical document metadata. Creating a document preserves its default grant and adds the upstream audience warning.

| Tool                               | Required arguments                           | Other arguments               |
| ---------------------------------- | -------------------------------------------- | ----------------------------- |
| `accept_service_account_transfer`  | `transfer_id`                                |                               |
| `create_comment`                   | `document_id`, `version_id`, `body`, `quote` | `prefix`, `suffix`            |
| `create_document`                  | `title`, `html`                              |                               |
| `create_folder`                    | `title`                                      | `parent_folder_id`            |
| `create_service_account_transfer`  | `service_account_id`, `to_user_email`        |                               |
| `decline_service_account_transfer` | `transfer_id`                                |                               |
| `delete_comment`                   | `document_id`, `comment_id`                  |                               |
| `delete_document`                  | `document_id`                                |                               |
| `delete_folder`                    | `folder_id`                                  |                               |
| `get_authoring_guidelines`         |                                              | `section`                     |
| `get_document`                     | `document_id`                                |                               |
| `get_document_html`                | `document_id`                                | `version_id`                  |
| `get_document_version`             | `document_id`, `version_id`                  |                               |
| `get_folder`                       | `folder_id`                                  |                               |
| `get_server_config`                |                                              |                               |
| `list_comments`                    | `document_id`                                | `status`, `version_id`        |
| `list_document_access`             | `document_id`                                |                               |
| `list_document_versions`           | `document_id`                                |                               |
| `list_documents`                   |                                              | `query`                       |
| `list_folder_access`               | `folder_id`                                  |                               |
| `list_folder_documents`            | `folder_id`                                  |                               |
| `list_folders`                     |                                              | `folder_id`, `path`           |
| `list_service_account_keys`        | `service_account_id`                         |                               |
| `list_service_account_transfers`   |                                              |                               |
| `list_service_accounts`            |                                              |                               |
| `move_document`                    | `document_id`                                | `folder_id`, `to_root`        |
| `move_document_to_folder`          | `folder_id`, `document_id`                   |                               |
| `move_document_to_root`            | `folder_id`, `document_id`                   |                               |
| `move_folder`                      | `folder_id`                                  | `parent_folder_id`            |
| `react_comment`                    | `document_id`, `comment_id`, `emoji`         |                               |
| `rename_document`                  | `document_id`, `title`                       |                               |
| `rename_folder`                    | `folder_id`, `title`                         |                               |
| `reopen_comment`                   | `document_id`, `comment_id`                  |                               |
| `reply_comment`                    | `document_id`, `comment_id`, `body`          |                               |
| `request_document_access`          | `document_id`                                |                               |
| `resolve_comment`                  | `document_id`, `comment_id`                  |                               |
| `revoke_document_grant`            | `document_id`, `grant_id`                    |                               |
| `revoke_folder_grant`              | `folder_id`, `grant_id`                      |                               |
| `revoke_service_account_key`       | `service_account_id`, `key_id`               |                               |
| `search_folders`                   | `query`                                      |                               |
| `share_document`                   | `document_id`                                | `address`, `everyone`, `role` |
| `share_folder`                     | `folder_id`                                  | `address`, `everyone`, `role` |
| `unreact_comment`                  | `document_id`, `comment_id`, `emoji`         |                               |
| `update_comment`                   | `document_id`, `comment_id`                  | `body`, `status`              |
| `update_document`                  | `document_id`, `base_version_id`, `html`     | `change_summary`              |
| `update_document_grant`            | `document_id`, `grant_id`, `role`            |                               |
| `update_folder_grant`              | `folder_id`, `grant_id`, `role`              |                               |
| `update_service_account`           | `service_account_id`                         | `disabled`, `name`            |
| `whoami`                           |                                              |                               |

## Verification

`workers/tests/mcp.test.ts` bundles and executes the actual app inside workerd with real D1, R2, and a SQLite-backed DocumentRealtime binding. It exercises the exact tool list and all 49 tool adapters, document/version multipart writes, comments/reactions, sharing, folder moves, service-account keys and transfers, OAuth consent/PKCE/replay, and credential/transport rejection. No external identity provider or live credentials are needed: authenticated users and sessions are seeded into D1.

All 49 adapters run against canonical handlers in workerd. `request_document_access` verifies D1 request persistence and a coalesced notification outbox row, with external delivery disabled. The root supplies canonical document metadata including `parent_folder_id` for `move_document` to root and mounts the canonical access-request handler.
