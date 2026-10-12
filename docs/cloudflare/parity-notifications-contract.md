# Notifications parity contract

Go sources: `api/internal/repo/postgres/notifications.go`,
`api/internal/notifications/{worker,slack,message}.go`, and
`api/internal/server/handlers_notifications.go`.

## Routes and durable state

`notificationRoutes` exports GET/PUT `/v1/me/notifications`, GET/PUT
`/v1/documents/:id/notifications`, and POST
`/v1/documents/:id/access-requests`. Mount behind the existing authentication
middleware. Remove the prior GET preference placeholders.

Preference defaults are enabled even without a configured sender. Document
preferences require viewer access and never grant access. Global disable overrides
a document enable. A user disable deletes that user's matching pending comment,
grant, and access-request events. Re-enable only affects future activity.

Access requests return identical `202 {"status":"sent"}` responses for missing,
already accessible, recently requested, and sender-disabled documents. Database
errors still fail the request. Configured denied requests coalesce for 24 hours,
including concurrent requests. The service-account document owner's human owner
receives requests; a requesting service account is labeled with its stored name.
The request receipt is stored even when the owner has muted notifications.

Migration `0006_notifications.sql` owns preferences, mutes, three outboxes,
access-request receipts, user delivery gates, and scratch tables used within
notification publication batches. Outbox timestamps are Unix milliseconds.

## Root configuration and integration

Add optional `SLASHDOCS_SLACK_BOT_TOKEN?: string` and
`NOTIFICATION_DELIVERY?: DurableObjectNamespace` to `Env`. A nonempty trimmed token
is the Go-equivalent feature switch. Keep the token in secret storage.

Export `NotificationDelivery` from `workers/app/src/notifications/delivery.ts` in
the Worker entrypoint. Configure a SQLite Durable Object binding named
`NOTIFICATION_DELIVERY`, class `NotificationDelivery`, and add it to a Wrangler
`new_sqlite_classes` migration. A single named object `notifications` schedules
alarms. Call `wakeNotificationDelivery(env)` after notification enqueue batches and
from scheduled recovery. A failed wake after a committed batch does not undo the
outbox; recovery must retry scheduling. The Worker must not return a failed
publication just because a postcommit wake fails. Log a generic scheduling error
and rely on scheduled recovery.

`0005_metadata.sql` supplies `document_workspace_entries`. Document opens must
record workspace entries for org-wide grant notifications. Grant notifications
never fan out to every user in the organization.

### Comment hooks

The exported SQL builders return `D1PreparedStatement[]`:

```ts
commentNotificationStatements(env, commentID, now = Date.now(), mutationToken?)
newMentionNotificationStatements(env, commentID, recipientIDs, now = Date.now(), mutationToken?)
captureNotificationMutation(env, token) // one D1PreparedStatement
clearNotificationMutation(env, token) // D1PreparedStatement[]
```

Create/reply: insert comment, capture mutation if CAS is used, write persisted
mentions, then append `commentNotificationStatements` inside the same D1 batch.
It derives recipients from stored user mentions, the parent user author, and the
human document owner. Mention wins over reply, which wins over owner activity.
Self, absent users, globally disabled recipients, and document-muted recipients
are suppressed. Service-account mentions and service-account owners are not
comment recipients, matching Go.

Edit: update comment with CAS, immediately append
`captureNotificationMutation(env, token)`, replace mentions, then append
`newMentionNotificationStatements(env, commentID, newlyAddedHumanIDs, now, token)`.
Append `...clearNotificationMutation(env, token)` last. The helper upgrades queued
owner/reply events to mention without delaying an earlier availability or resetting
attempts. It never re-notifies existing mentions or an ordinary owner on edit.

The mutation capture reads SQLite `changes()` on the batch connection. Do not put
another statement between the CAS and capture. A zero-change CAS blocks enqueueing.
Use an unguessable token such as `crypto.randomUUID()` per publication.

### Grant hooks

Use the SQL snapshot hooks, which capture before and after state inside the same
D1 batch, rather than separate read calls:

```ts
const token = crypto.randomUUID();
await env.DB.batch([
  ...snapshotGrantNotificationStatements(env, documentID, grantee, token),
  grantCASStatement,
  captureNotificationMutation(env, token),
  ...queuedGrantNotificationStatements(env, actor.principal, token),
  ...clearNotificationMutation(env, token),
]);
```

A user grantee compares direct grant roles, regardless of inherited access. Anyone
grants compare effective access for human users who opened the document, including
inherited and verified group access. Other principal types do not generate grant
notifications, matching Go. Actor self-events are suppressed. Coalescing preserves
the original previous role, resets attempts and age on a new change, and deletes
an event that returns to its original role.

The standalone `documentGrantAccessSnapshot` and `accessNotificationStatements`
helpers are useful for contracts, but concurrent production writes should use the
transaction-local SQL hooks above.

## Delivery and Slack

Each alarm processes one event from each queue, matching Go's one-second cadence.
Claims atomically increment attempts and lease for one minute. Events strictly
older than 24 hours expire. Finish matches the logical key and attempt to avoid
finishing an older lease. A D1 user gate reserves one delivery every six seconds
across queues and instances.

The alarm keeps a one-second recovery wake armed during delivery. Wake requests
atomically increment a persisted generation and preserve the earliest alarm in a
Durable Object storage transaction. Final scheduling checks that generation in the
same transaction as its alarm update. If a wake arrived during processing, the
possibly stale D1 minimum cannot delete or postpone its alarm. Reentrant alarms
record another wake and return without starting a concurrent queue pass. Storage
transactions cover only local generation and alarm updates, never D1 or Slack
requests. Scheduling adds no D1 queries.

Delivery rechecks preferences, comment visibility, reader access, current direct
or effective grant role, current request owner, and whether the requester is still
denied. Group membership refresh and unavailable-group errors follow the shared
permission service. Stale, unauthorized, deleted, or ineligible work is discarded.
Transient failures back off `2^min(attempts, 8)` seconds; Slack Retry-After can
increase that delay. Go's permanent Slack status codes discard events. Slack calls
use five-second timeouts, refuse redirects, and cap response reads at one MiB.

Slack lookup-by-email, DM open, and message post use the upstream payload layout.
Preview redaction runs before Unicode truncation. Literal rich-text elements
prevent untrusted comment text from creating mentions. Fallback disables mrkdwn,
parsing, link names, and unfurls. Removed-access messages have no action button.
Logs expose only a fixed delivery code, queue kind, and retry decision.

## Verification

`workers/tests/notifications.test.ts` runs real Miniflare D1 contracts for defaults,
preferences and backlog removal, API validation/authorization, enumeration-safe
requests, concurrent 24-hour coalescing, service-account owner mapping, recipient
priority, edit upgrades, failed CAS, grant coalescing, leases/expiration, stale
delivery suppression, recipient gates, and retries. Slack HTTP tests mock only the
external provider.

`workers/tests/notification-delivery.test.ts` bundles the actual exported Durable
Object in workerd, schedules a real alarm, and verifies its persisted D1 event is
delivered and removed through mocked Slack HTTP. Network access is disabled in this
test; it cannot send live Slack messages. Its interleaving regressions pause a real
D1 minimum response during a workerd alarm, enqueue another event, and wake the
same SQLite Durable Object. Both empty and future minimum results must preserve
the earlier wake. Concurrent wakes and a reentrant alarm are also exercised, along
with continuous activity that must not postpone delivery.

Full parity still depends on root wiring all mutation hooks, the Durable Object
binding/export, scheduled recovery, and document-open tracking. This module does
not independently replace shared permission semantics or Google-group policy.
