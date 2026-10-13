# Comment API contract

The Cloudflare comment API follows the Go handlers, Postgres comment repository,
and `api/internal/server/json.go` at upstream commit `6ccc967`.

The exported `commentRoutes` owns these endpoints:

- `GET /v1/documents/:id/comments`
- `POST /v1/documents/:id/comments`
- `POST /v1/documents/:id/comments/:comment_id/replies`
- `PATCH /v1/documents/:id/comments/:comment_id`
- `DELETE /v1/documents/:id/comments/:comment_id`
- `PUT /v1/documents/:id/comments/:comment_id/reactions/:emoji`
- `DELETE /v1/documents/:id/comments/:comment_id/reactions/:emoji`

Creation, replies, reactions, and author/editor updates require current commenter
access. Editors can update another author's body, mentions, or status; deletion
requires the author. The inherited document and folder predicates are evaluated
again inside every mutation. Missing comments return 403 for patch/delete and
404 for replies/reactions; a comment in another document returns 404. Deletion
removes the visible descendant thread, including descendants of an intermediate
reply. Reactions use the existing nine Go slugs and remain idempotent. Emoji groups
follow first-reaction order, with Go's emoji/type/ID tie breakers. Reactor DTOs
omit pictures, matching the Postgres query.

## Structured mentions

Nonempty creation/reply mention lists require
`application/vnd.slashdocs.comment-mentions+json`. Every non-null patch mention
list, including `[]`, requires that media type. The pre-rename
`application/vnd.aidocs.comment-mentions+json` is accepted as in Go. Ordinary
JSON can carry empty creation/reply lists. Malformed MIME parameters are rejected.
Legacy U+2063 in-band markers are rejected.

Up to 50 mentions may reference real user or service-account identities. Offsets
and lengths use UTF-16 code units and cannot split code points or overlap.
Validation preserves Go's preceding-space/bracket and trailing-Unicode-punctuation
boundaries. Visible text must exactly match `@name`, `@email`, or `@id`. Wire
names, emails, and pictures are ignored; DTO identities come from D1. Go does not
require the mentioned principal to have a document grant. Notification delivery
separately checks recipient access.

`label_text` preserves the exact visible text. Existing renamed labels can be
moved when supplied in a patch, with the previous count limiting how many old
occurrences may survive. Fresh comments cannot use an old or spoofed label.
Omitted mentions survive status-only or identical-body patches; changing the
body clears them unless replacement mentions are supplied. Null mentions behave
as omitted. All new DTOs contain mention and reaction arrays.

Canonical principal lookup uses one bulk query and mention insertion uses one
`json_each` statement, so 50 mentions do not consume 50 D1 queries. Comment lists
read comments, version metadata, reactions, and mentions in one four-statement
D1 transaction. Root and reply grouping is then performed against that snapshot.
Author names/emails are captured at creation as in the Go repository.

## Placement and filtering

Root DTOs contain `selected_text`, an anchor with all six Go fields, and
`current_placement`. Replies contain `parent_comment_id`; they omit placement,
anchor, and the internal `root_comment_id`.

Placement deliberately matches the current Go implementation: an original
version is attached; a different version with nonempty raw HTML is orphaned only
when that HTML does not contain the selected text. Confidence is respectively
1 or 0. Empty/unavailable version content remains attached. There is no DOM,
heading, approximate, entity-decoding, or text-normalization relocation in the Go
comment placement response.

The Postgres repository applies a literal stored-status filter before thread
assembly. An omitted/empty status lists all rows; `open` and `resolved` select
those rows, including replies. Although the handler's documentation advertises
`all`, `stale`, and `orphaned`, these values (and unknown values) select no rows
in the actual upstream Postgres query. The Cloudflare API preserves this behavior.
`version_id` filters creation versions and selects the placement HTML.

## Notifications and realtime

Comment creation and newly mentioned users enqueue outbox rows in the same D1
batch as the comment mutation and mention replacement. A transaction-local guard
captures the mutation's affected-row count immediately after its CAS statement;
failed mutations cannot replace mentions or enqueue notifications. Delivery is
woken after a successful commit. All successful comment/reaction route mutations
announce a `comments` document event. Delivery wakes and realtime announcements
are best effort after commit, so infrastructure failure cannot turn a committed
comment into a reported write failure.

## Storage differences and verification

D1 keeps soft-deleted audit rows; Postgres physically cascades deletion. Both
exclude the entire deleted descendant tree from comment APIs. D1 uses an
optimistic `updated_at` check for concurrent updates instead of a Postgres row
lock; a stale update is rejected rather than silently overwriting a newer body
and its mentions. Principal lookups occur before the mutation batch, so D1 does
not reproduce Postgres's principal-row key-share locks during a concurrent
rename or deletion. These are storage/concurrency differences, not additional
mention feature restrictions.

`workers/tests/comments.test.ts` exercises real Miniflare D1/R2 storage for
structured user/SA mentions, UTF-16 offsets, Unicode punctuation, 50-mention
limits, historical labels, patch tri-state behavior, MIME handling, nested reply
deletion, placement/filtering, and notification exclusion on a failed CAS.
`review.test.ts` retains author/editor/current-access coverage; the comment
section of `list-budget.test.ts` verifies bulk hydration in four statements.
