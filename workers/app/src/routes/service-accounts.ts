import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { newId } from "../../../shared/ids";
import { botDomain } from "../auth/bot-address";
import { hashToken, randomToken } from "../auth/tokens";
const labelSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/);
const domainSchema = z
  .string()
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.bot$/,
  );
type AccountRow = {
  id: string;
  name: string;
  disabled_at: string | null;
  owner_id: string;
  owner_email: string;
  owner_name: string;
};
const accountSQL =
  "SELECT sa.id,sa.name,sa.disabled_at,u.id AS owner_id,u.email AS owner_email,u.name AS owner_name FROM service_accounts sa JOIN users u ON u.id=sa.owner_user_id";
function accountDTO(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    disabled: row.disabled_at !== null,
    owner: {
      type: "user",
      id: row.owner_id,
      email: row.owner_email,
      name: row.owner_name,
    },
  };
}
function userID(c: Context<AppEnv>) {
  const p = c.get("actor").principal;
  if (p.type !== "user")
    throw new ApiError(403, "forbidden", "user principal required");
  return p.id;
}
async function owned(c: Context<AppEnv>, id: string) {
  const user = userID(c);
  const row = await c.env.DB.prepare(`${accountSQL} WHERE sa.id=?`)
    .bind(id)
    .first<AccountRow>();
  if (!row || row.owner_id !== user)
    throw new ApiError(403, "forbidden", "service account owner required");
  return row;
}
async function input(c: Context<AppEnv>) {
  if (!c.req.header("Content-Type")?.startsWith("application/json"))
    throw new ApiError(400, "bad_request", "JSON body required");
  return c.req.json();
}
export const serviceAccountRoutes = new Hono<AppEnv>();
serviceAccountRoutes.post("/v1/service-accounts", async (c) => {
  const owner = userID(c);
  const body = z
    .object({ label: labelSchema, domain: domainSchema.optional() })
    .parse(await input(c));
  const id = newId("sa"),
    keyId = newId("sak"),
    token = `slashdocs_sa_${randomToken()}`,
    now = new Date().toISOString();
  let name = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    name = `${body.label}@${body.domain || botDomain(attempt >= 8)}`;
    const exists = await c.env.DB.prepare(
      "SELECT id FROM service_accounts WHERE name=?",
    )
      .bind(name)
      .first();
    if (!exists) break;
    if (body.domain)
      throw new ApiError(
        409,
        "address_taken",
        `Someone already uses ${name}. Try a different address.`,
      );
    if (attempt === 11)
      throw new ApiError(
        409,
        "address_taken",
        "Could not allocate an unused bot address",
      );
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users (id,provider,provider_subject,email,name,picture_url,created_at) VALUES (?,'service_account',?,'',?,'',?)",
    ).bind(id, id, name, now),
    c.env.DB.prepare(
      "INSERT INTO service_accounts (id,name,owner_user_id,created_by_user_id,created_at) VALUES (?,?,?,?,?)",
    ).bind(id, name, owner, owner, now),
    c.env.DB.prepare(
      "INSERT INTO service_account_keys (id,service_account_id,name,token_hash,created_at) VALUES (?,?,'default',?,?)",
    ).bind(keyId, id, await hashToken(token), now),
  ]);
  const row = await owned(c, id);
  return c.json(
    {
      ...accountDTO(row),
      label: body.label,
      owner: { id: row.owner_id, email: row.owner_email },
      grants: [],
      key: { id: keyId, token },
    },
    201,
  );
});
serviceAccountRoutes.get("/v1/service-accounts", async (c) => {
  const rows = await c.env.DB.prepare(
    `${accountSQL} WHERE sa.owner_user_id=? ORDER BY sa.created_at DESC`,
  )
    .bind(userID(c))
    .all<AccountRow>();
  return c.json({ items: rows.results.map(accountDTO) });
});
serviceAccountRoutes.patch("/v1/service-accounts/:id", async (c) => {
  const id = c.req.param("id");
  await owned(c, id);
  const body = z
    .object({ name: z.string().optional(), disabled: z.boolean().optional() })
    .parse(await input(c));
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE service_accounts SET name=CASE WHEN ?='' THEN name ELSE ? END,disabled_at=CASE WHEN ? IS NULL THEN disabled_at WHEN ?=1 THEN COALESCE(disabled_at,?) ELSE NULL END WHERE id=? AND owner_user_id=?",
    ).bind(
      body.name || "",
      body.name || "",
      body.disabled ?? null,
      body.disabled ?? null,
      new Date().toISOString(),
      id,
      userID(c),
    ),
    c.env.DB.prepare(
      "UPDATE users SET name=CASE WHEN ?='' THEN name ELSE ? END WHERE id=? AND changes()=1",
    ).bind(body.name || "", body.name || "", id),
  ]);
  if (!result[0].meta.changes)
    throw new ApiError(403, "forbidden", "service account owner required");
  return c.json(accountDTO(await owned(c, id)));
});
serviceAccountRoutes.post("/v1/service-accounts/:id/keys", async (c) => {
  const sa = c.req.param("id");
  await owned(c, sa);
  const raw = await c.req.text();
  if (raw && !c.req.header("Content-Type")?.startsWith("application/json"))
    throw new ApiError(400, "bad_request", "JSON body required");
  const body = z
    .object({ name: z.string().optional() })
    .parse(raw ? JSON.parse(raw) : {});
  const id = newId("sak"),
    token = `slashdocs_sa_${randomToken()}`;
  const result = await c.env.DB.prepare(
    "INSERT INTO service_account_keys (id,service_account_id,name,token_hash,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM service_accounts WHERE id=? AND owner_user_id=?)",
  )
    .bind(
      id,
      sa,
      body.name || "default",
      await hashToken(token),
      new Date().toISOString(),
      sa,
      userID(c),
    )
    .run();
  if (!result.meta.changes)
    throw new ApiError(403, "forbidden", "service account owner required");
  return c.json({ id, token }, 201);
});
serviceAccountRoutes.get("/v1/service-accounts/:id/keys", async (c) => {
  const id = c.req.param("id");
  await owned(c, id);
  const rows = await c.env.DB.prepare(
    "SELECT id,name FROM service_account_keys WHERE service_account_id=? AND revoked_at IS NULL ORDER BY created_at DESC",
  )
    .bind(id)
    .all();
  return c.json({ items: rows.results });
});
serviceAccountRoutes.delete("/v1/service-accounts/:id/keys/:key_id", async (c) => {
  const id = c.req.param("id");
  await owned(c, id);
  const result = await c.env.DB.prepare(
    "UPDATE service_account_keys SET revoked_at=? WHERE service_account_id=? AND id=? AND EXISTS (SELECT 1 FROM service_accounts WHERE id=? AND owner_user_id=?)",
  )
    .bind(new Date().toISOString(), id, c.req.param("key_id"), id, userID(c))
    .run();
  if (!result.meta.changes) await owned(c, id);
  return c.body(null, 204);
});
type TransferRow = {
  id: string;
  service_account_id: string;
  from_user_id: string;
  to_user_id: string;
  status: string;
};
const transferColumns = "id,service_account_id,from_user_id,to_user_id,status";
serviceAccountRoutes.post("/v1/service-accounts/:id/transfer", async (c) => {
  const sa = c.req.param("id"),
    from = userID(c);
  await owned(c, sa);
  const body = z.object({ to_user_email: z.string().min(1) }).parse(await input(c));
  // A login or another invitation may create the recipient concurrently. D1
  // evaluates the existence check and placeholder insertion in one write.
  const targetId = newId("usr");
  await c.env.DB.prepare(
    "INSERT INTO users (id,provider,provider_subject,email,name,picture_url,created_at) SELECT ?,'placeholder',?,?,?,'',? WHERE NOT EXISTS (SELECT 1 FROM users WHERE provider!='service_account' AND email=? COLLATE NOCASE)",
  )
    .bind(
      targetId,
      targetId,
      body.to_user_email.toLowerCase(),
      body.to_user_email,
      new Date().toISOString(),
      body.to_user_email,
    )
    .run();
  const target = await c.env.DB.prepare(
    "SELECT id FROM users WHERE provider!='service_account' AND email=? COLLATE NOCASE",
  )
    .bind(body.to_user_email)
    .first<{ id: string }>();
  if (!target)
    throw new ApiError(
      409,
      "invalid_transfer_state",
      "Recipient changed during transfer creation",
    );
  const transfer = {
    id: newId("xfer"),
    service_account_id: sa,
    from_user_id: from,
    to_user_id: target.id,
    status: "pending",
  };
  const result = await c.env.DB.prepare(
    "INSERT INTO ownership_transfers (id,service_account_id,from_user_id,to_user_id,status,initiated_at) SELECT ?,?,?,?,'pending',? WHERE EXISTS (SELECT 1 FROM service_accounts WHERE id=? AND owner_user_id=?)",
  )
    .bind(transfer.id, sa, from, target.id, new Date().toISOString(), sa, from)
    .run();
  if (!result.meta.changes)
    throw new ApiError(403, "forbidden", "service account owner required");
  return c.json(transfer, 201);
});
serviceAccountRoutes.get("/v1/service-accounts/transfers", async (c) => {
  const id = userID(c);
  const rows = await c.env.DB.prepare(
    `SELECT ${transferColumns} FROM ownership_transfers WHERE from_user_id=? OR to_user_id=? ORDER BY initiated_at DESC`,
  )
    .bind(id, id)
    .all<TransferRow>();
  return c.json({ items: rows.results });
});
serviceAccountRoutes.post("/v1/service-accounts/transfers/:id/accept", async (c) => {
  const user = userID(c),
    id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT ${transferColumns} FROM ownership_transfers WHERE id=?`,
  )
    .bind(id)
    .first<TransferRow>();
  if (!row) throw new ApiError(404, "not_found", "Transfer not found");
  if (row.to_user_id !== user)
    throw new ApiError(403, "forbidden", "you are not the recipient of this transfer");
  if (row.status !== "pending")
    throw new ApiError(409, "invalid_transfer_state", "transfer is not pending");
  // changes() belongs to the preceding statement in this atomic D1 batch.
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE ownership_transfers SET status='accepted',accepted_at=? WHERE id=? AND status='pending' AND to_user_id=? AND EXISTS (SELECT 1 FROM service_accounts WHERE id=ownership_transfers.service_account_id AND owner_user_id=ownership_transfers.from_user_id)",
    ).bind(new Date().toISOString(), id, user),
    c.env.DB.prepare(
      "UPDATE service_accounts SET owner_user_id=? WHERE id=? AND changes()=1",
    ).bind(user, row.service_account_id),
    // Retire other offers from the prior ownership period, even if ownership
    // later returns to the same sender.
    c.env.DB.prepare(
      "UPDATE ownership_transfers SET status='declined' WHERE service_account_id=? AND status='pending' AND changes()=1",
    ).bind(row.service_account_id),
  ]);
  if (!result[0].meta.changes)
    throw new ApiError(409, "invalid_transfer_state", "transfer is not pending");
  return c.json({ ...row, status: "accepted" });
});
serviceAccountRoutes.post("/v1/service-accounts/transfers/:id/decline", async (c) => {
  const user = userID(c);
  const result = await c.env.DB.prepare(
    "UPDATE ownership_transfers SET status='declined' WHERE id=? AND status='pending' AND (from_user_id=? OR to_user_id=?)",
  )
    .bind(c.req.param("id"), user, user)
    .run();
  if (!result.meta.changes)
    throw new ApiError(
      409,
      "invalid_transfer_state",
      "transfer is not pending or not found",
    );
  return c.body(null, 204);
});
