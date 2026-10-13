# Document metadata and search contract

Reference: Go upstream `6ccc967`, `server.go`, document/label/link handlers,
`search_query.go`, `search_dates.go`, and Postgres `search_text.go`.

`documentRoutes` exports the existing document CRUD endpoints and Go's
`GET /v1/documents/:id/headings` and `GET /v1/documents/:id/link`.
`labelRoutes` exports only Go's GET/PUT `/v1/documents/:id/labels`; there is no
additional global labels endpoint.

## Search and workspace

Document listing returns at most 25 root documents. A broad anyone grant alone
never adds a document to a public user's workspace. Opening a document records
an idempotent workspace entry; revoking broad access removes its visibility.
Search includes explicit document/folder ancestor grants and permits anyone
access for org deployments. Aggregate queries require a current group snapshot.
Group SQL predicates use the current environment's configuration.

The authenticated app GET delegates listing to the private `DOCUMENT_SEARCH`
binding, using one SQLite-backed `DocumentSearch` object per principal type/ID.
`POST https://search.internal/list` accepts only `{actor, q, tz, label}`; no public
HTTP endpoint accepts actor bodies or headers. Its bounded 128 KiB JSON body
requires a user session/CLI/MCP or native service-account credential ID.
The object revalidates the exact credential against D1, including session/MCP
expiry, revocation, disabled service accounts, and MCP user/resource/scope. It
refreshes group membership using its own bound environment before calling the
unchanged `listDocuments` domain function, returning the same `{items}` and
API error status/body. Actors, caller configuration and group IDs are not cached
or persisted. Standalone fixtures without a namespace retain the domain fallback;
generated production configuration must always bind this class.

Queries accept words, quoted phrases, exclusions, `from`/`author`, `in`,
`label`/`labels`, and `before`/`after`/`on`/`during`. Owner and folder modifiers
combine with OR; labels and date constraints combine with AND. Unusable partial
modifiers are ignored. Limits match Go: 512 UTF-8 bytes and ten values per class.
The deprecated label parameter remains supported when labels are enabled.

Dates use the searcher's IANA `tz`, default UTC. Calendar days, day-first and
year-first numeric forms, named months and weekdays, relative periods, ordinals,
and most recent yearless dates mirror Go. Each local midnight is converted
separately, including daylight-saving boundaries.

Source text excludes script/style/template/noscript, separates text tokens and
whitespace/control characters, and caps indexed text at 256 KiB. Invalid UTF-8
bytes are removed after token extraction; genuine U+FFFD remains text. English
Snowball stemming, stop-word positions, prefix matching, phrase order,
exclusions, compound components, emails, domains, URL paths, and numeric lexemes
are implemented. PostgreSQL default weighted `ts_rank` formulas and
`ts_headline` single-fragment selection are ported with float32 rank arithmetic.
Matching and exclusions use PostgreSQL stored-vector positions: positions clamp
at 16383, duplicates are removed per lexeme, `to_tsvector` retains 255 positions
(`MAXNUMPOS - 1`), and title/body concatenation can retain 256 (`MAXNUMPOS`).
Headlines use separate raw parser positions. Advancing occurrence/document
cursors avoid quadratic scans, and only the selected 25 results receive snippets.
Repeated words share a per-parse stem cache. Snippets use U+0002/U+0003 match
markers and remain untrusted plain text.

Ten direct differential fixtures against PostgreSQL 18 matched result presence,
rank, and snippets. These include mixed title/body matches, repeated prefixes,
compounds, email/URL lexemes, and long snippets. Recorded reference cases and
real Miniflare D1/R2 endpoint tests live in `workers/tests/metadata.test.ts`.

## Labels, headings, and links

Labels default disabled, matching Go main/servercfg, and return 404
`feature_disabled`. `LABELS_ENABLED=true` enables full GET/PUT behavior.
Replacement normalizes, sorts, and deduplicates labels with Go's twenty-input
limit and label grammar. A same-batch CHECK guard prevents partial replacement
if document/editor access disappears.

Heading extraction reserves every authored ID before generating ASCII slugs,
suffixes collisions, and ignores template contents. Source HTML is never
rewritten. Explicit `version` pins heading links; omitted version links follow
the current document. Link validation enforces document-scoped versions and
comments, mutual exclusivity of comments versus heading/version, and Go's
1024-byte heading limit. Runtime-generated heading IDs remain valid links.

## Publication and production backfill

`sourceMetadataStatements(env, versionId, bytes)` belongs after the version
INSERT inside the same atomic publication batch. Both initial creation and
version publication use it, so a losing publication cannot leave metadata.
Migration `0005_metadata.sql` adds source text/headings, labels/workspace,
comment mention labels, historical author fields, and reaction timestamps.

`indexCurrentVersionBatch(env, after)` processes at most twenty unindexed current
versions and returns `{indexed, failed, nextCursor}`. Continue with `nextCursor`;
start another sweep at an empty cursor to retry transient R2/D1 failures. Missing
objects receive empty metadata, as Go does. The private object also accepts `POST https://search.internal/index` with
`{after}` and runs this same batch function under the DO request CPU budget.
Possession of the private namespace binding authorizes scheduled/admin maintenance;
there is no public index endpoint or caller-supplied environment. Root owns the
production maintenance runner and deployment wiring. `indexCurrentVersions` wraps batches for tests and
internal maintenance.

## Remaining limits

This is a JavaScript port, not PostgreSQL's native parser. The sampled differential
fixtures do not prove every specialized default-parser token, nested markup,
Unicode classification, dictionary-version, or locale/collation case. SQL owner
email lowercasing and final title ordering can differ from a PostgreSQL deployment's
locale. parse5 and Go's HTML parser can repair malformed HTML differently.
Very large malformed UTF-8 streams near the byte cap have not been exhaustively
compared. A search currently reads accessible D1 candidates and ranks their
persisted source text in a Durable Object rather than using a PostgreSQL inverted
index; large corpora still have candidate-scan, D1 result-size and CPU limits.

Comment storage and concurrent mutation differences are documented in
`comments-parity.md`. There are no artificial unsupported-search/mention
feature flags or added input restrictions beyond the Go limits.

## Focused review fixes and performance evidence

The position-clamp regression (`"filler ".repeat(17000) + "alpha beta"`) now
rejects the phrase `"alpha beta"`, including when used as an exclusion, because
both stored positions are 16383. Separate raw headline positions still produce
the PostgreSQL fragment for an AND query. Local PostgreSQL 18 confirms the
255/256 position limits and the saturated repeated-word rank. All ten original
direct differential cases still agree on presence, rank and snippets.

`workers/tests/metadata-search-workerd.test.ts` measures the domain function in
workerd with D1/R2 and the reviewed 262143-byte high-frequency body. Its host
elapsed measurements include D1/IPC and do not establish production CPU usage.
`workers/tests/document-search-workerd.test.ts` runs a fresh full app with a real
SQLite namespace and asserts that the public GET crosses the binding into
`DocumentSearch` before searching that body. It also exercises exact credential
revalidation, current group/customer permissions, Go errors, HTTP spoof rejection,
body limits, resource errors and private source-index maintenance.

The operational CPU-placement fix uses Cloudflare's documented default
[30-second CPU budget per SQLite Durable Object request](https://developers.cloudflare.com/durable-objects/platform/limits/),
including Workers Free, whose Durable Objects require SQLite storage. It requires
no paid feature or CPU-limit override. This removes search and maintenance CPU
from the ordinary Free Worker request's 10 ms budget. Local workerd placement and
elapsed timing do not prove production CPU consumption or an unlimited Free
service: Worker/DO request and duration quotas, D1 read/write quotas, R2 quotas,
per-object overload, and large candidate scans remain operational constraints.
The domain search grammar, ranking, snippets and valid-query acceptance remain
unchanged; this does not add indexed vectors, SQL text filtering or candidate caps.
