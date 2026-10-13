import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  api,
  type APIError,
  type AdminUser,
  type AdminUserStatus,
  type AdminDocumentKind,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { adminAccessError } from "@/lib/admin-access";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
interface IAdminUsers {
  active: boolean;
  onUnauthorized: (error: APIError) => void;
}
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not recorded";
export function AdminUsersPanel(props: IAdminUsers) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<AdminUserStatus>("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const users = useQuery({
    queryKey: queryKeys.adminUsers(search, status, page),
    queryFn: () => api.adminUsers(search, status, page),
    enabled: props.active,
    retry: false,
    refetchInterval: 60000,
  });
  const denied = adminAccessError(users.error);
  const { onUnauthorized } = props;
  useEffect(() => {
    if (denied) onUnauthorized(denied);
  }, [denied, onUnauthorized]);
  if (denied) return null;
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="text-lg font-medium">People on the platform</h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Find a person and view the documents they uploaded. Invitations and bots are
          excluded.
        </p>
        <form
          className="my-4 flex flex-wrap gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draft.trim());
            setPage(1);
            setSelected(null);
          }}
        >
          <Input
            aria-label="Search users by name or email"
            placeholder="Search name or email"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full sm:w-72"
          />
          <select
            aria-label="Filter users"
            value={status}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3"
            onChange={(event) => {
              const value = event.target.value;
              if (value !== "all" && value !== "logged_in" && value !== "active")
                return;
              setStatus(value);
              setPage(1);
              setSelected(null);
            }}
          >
            <option value="all">All signed-up users</option>
            <option value="logged_in">Logged-in users</option>
            <option value="active">Active in 24 hours</option>
          </select>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {users.isLoading && <p>Loading users…</p>}
        {users.isError && (
          <p role="alert">Could not load users. Refresh to try again.</p>
        )}
        {users.data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead>
                  <tr>
                    <th className="pb-3">User</th>
                    <th className="pb-3">Login status</th>
                    <th className="pb-3">Account created</th>
                    <th className="pb-3">Last sign-in</th>
                    <th className="pb-3">Last active</th>
                    <th className="pb-3">Documents uploaded</th>
                    <th className="pb-3">Versions uploaded</th>
                    <th className="pb-3">API operations · 30d</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((user) => (
                    <tr
                      key={user.id}
                      className="border-t border-[var(--color-border)] align-top"
                    >
                      <td className="py-3 pr-4">
                        <button
                          className="text-left underline underline-offset-4"
                          aria-label={`${user.name || user.email} — View documents for ${user.email}`}
                          aria-pressed={selected?.id === user.id}
                          onClick={() => setSelected(user)}
                        >
                          {user.name || user.email}
                        </button>
                        <p className="mt-1 text-[var(--color-fg-muted)]">
                          {user.email}
                        </p>
                      </td>
                      <td className="py-3 pr-4">
                        {user.sessions > 0 ? "Logged in" : "No active session"}
                        <p className="text-[var(--color-fg-muted)]">
                          {user.sessions} {user.sessions === 1 ? "session" : "sessions"}
                        </p>
                      </td>
                      <td className="py-3 pr-4">{date(user.created_at)}</td>
                      <td className="py-3 pr-4">{date(user.last_login_at)}</td>
                      <td className="py-3 pr-4">{date(user.last_active_at)}</td>
                      <td className="py-3 pr-4">
                        {user.documents_uploaded.toLocaleString()}
                      </td>
                      <td className="py-3 pr-4">
                        {user.versions_uploaded.toLocaleString()}
                      </td>
                      <td className="py-3">{user.requests_30d.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {users.data.items.length === 0 && (
              <p className="py-4">No users match your search.</p>
            )}
            <div className="mt-4 flex items-center gap-3">
              <Button
                variant="outline"
                disabled={page === 1 || users.isFetching}
                onClick={() => setPage(page - 1)}
              >
                Previous users
              </Button>
              <span>Page {page}</span>
              <Button
                variant="outline"
                disabled={!users.data.has_more || users.isFetching}
                onClick={() => setPage(page + 1)}
              >
                Next users
              </Button>
            </div>
          </>
        )}
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          Logged in means an unexpired browser session, not online presence. Older
          sign-ins may have no recorded time. Last active reflects API use within the
          retained activity window.
        </p>
      </Card>
      {selected && (
        <UserDocuments
          key={selected.id}
          user={selected}
          active={props.active}
          onClose={() => setSelected(null)}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  );
}

interface IUserDocuments {
  active: boolean;
  user: AdminUser;
  onClose: () => void;
  onUnauthorized: (error: APIError) => void;
}
function UserDocuments(props: IUserDocuments) {
  const { user: selected, onClose, onUnauthorized } = props;
  const details = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<AdminDocumentKind>("uploaded");
  const [documentSearch, setDocumentSearch] = useState("");
  const [documentDraft, setDocumentDraft] = useState("");
  const [documentPage, setDocumentPage] = useState(1);
  const documents = useQuery({
    queryKey: queryKeys.adminUserDocuments(
      selected.id,
      kind,
      documentSearch,
      documentPage,
    ),
    queryFn: () =>
      api.adminUserDocuments(selected.id, kind, documentSearch, documentPage),
    enabled: props.active,
    retry: false,
    refetchInterval: 60000,
  });
  const denied = adminAccessError(documents.error);
  useEffect(() => {
    details.current?.focus({ preventScroll: true });
    details.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);
  useEffect(() => {
    if (denied) onUnauthorized(denied);
  }, [denied, onUnauthorized]);
  if (denied) return null;
  return (
    <div
      ref={details}
      tabIndex={-1}
      aria-label={`Documents for ${selected.name || selected.email}`}
      className="scroll-mt-24"
    >
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">
              Documents · {selected.name || selected.email}
            </h2>
            <p className="text-sm text-[var(--color-fg-muted)]">
              {selected.email} · {selected.owned_documents} owned{" "}
              {selected.owned_documents === 1 ? "document" : "documents"}
            </p>
          </div>
          <Button variant="outline" onClick={onClose}>
            Close user details
          </Button>
        </div>
        <div className="my-4 flex flex-wrap gap-3">
          <Button
            variant={kind === "uploaded" ? "primary" : "outline"}
            aria-pressed={kind === "uploaded"}
            onClick={() => {
              setKind("uploaded");
              setDocumentPage(1);
            }}
          >
            Uploaded by this user
          </Button>
          <Button
            variant={kind === "owned" ? "primary" : "outline"}
            aria-pressed={kind === "owned"}
            onClick={() => {
              setKind("owned");
              setDocumentPage(1);
            }}
          >
            Owned by this user
          </Button>
        </div>
        <form
          className="mb-4 flex flex-wrap gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setDocumentSearch(documentDraft.trim());
            setDocumentPage(1);
          }}
        >
          <Input
            aria-label="Search this user's documents"
            placeholder="Search document title or ID"
            value={documentDraft}
            onChange={(event) => setDocumentDraft(event.target.value)}
            className="w-full sm:w-72"
          />
          <Button type="submit" variant="outline">
            Search documents
          </Button>
        </form>
        {documents.isLoading && <p>Loading documents…</p>}
        {documents.isError && (
          <p role="alert">
            Could not load this user's documents. Refresh to try again.
          </p>
        )}
        {documents.data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead>
                  <tr>
                    <th className="pb-3">Document</th>
                    <th className="pb-3">Owner</th>
                    <th className="pb-3">First uploaded by user</th>
                    <th className="pb-3">Last uploaded by user</th>
                    <th className="pb-3">Versions uploaded</th>
                    <th className="pb-3">Uploaded HTML</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.data.items.map((doc) => (
                    <tr
                      key={doc.id}
                      className="border-t border-[var(--color-border)] align-top"
                    >
                      <td className="py-3 pr-4">
                        <Link
                          className="underline underline-offset-4"
                          to={`/app/d/${encodeURIComponent(doc.id)}`}
                        >
                          {doc.title || "Untitled document"}
                        </Link>
                        <p className="mt-1 text-[var(--color-fg-muted)]">{doc.id}</p>
                      </td>
                      <td className="py-3 pr-4">
                        {doc.owner_name || doc.owner_email}
                        <p className="text-[var(--color-fg-muted)]">
                          {doc.owner_type === "service_account"
                            ? "Service account"
                            : doc.owner_email}
                        </p>
                      </td>
                      <td className="py-3 pr-4">
                        {doc.versions_uploaded
                          ? date(doc.first_upload_at)
                          : "No uploads"}
                      </td>
                      <td className="py-3 pr-4">
                        {doc.versions_uploaded
                          ? date(doc.last_upload_at)
                          : "No uploads"}
                      </td>
                      <td className="py-3 pr-4">
                        {doc.versions_uploaded} of {doc.total_versions} total
                      </td>
                      <td className="py-3">
                        {doc.storage_bytes.toLocaleString()} bytes
                        {doc.unknown_size_versions > 0 && (
                          <p>{doc.unknown_size_versions} unknown-size versions</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {documents.data.items.length === 0 && (
              <p className="py-4">
                {kind === "uploaded"
                  ? "This user has no retained uploads matching your search."
                  : "This user owns no matching documents."}
              </p>
            )}
            <div className="mt-4 flex items-center gap-3">
              <Button
                variant="outline"
                disabled={documentPage === 1 || documents.isFetching}
                onClick={() => setDocumentPage(documentPage - 1)}
              >
                Previous documents
              </Button>
              <span>Page {documentPage}</span>
              <Button
                variant="outline"
                disabled={!documents.data.has_more || documents.isFetching}
                onClick={() => setDocumentPage(documentPage + 1)}
              >
                Next documents
              </Button>
            </div>
          </>
        )}
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          Uploads are attributed to the author of each version. Ownership is separate.
          Opening a document uses its sharing permissions.
        </p>
      </Card>
    </div>
  );
}
