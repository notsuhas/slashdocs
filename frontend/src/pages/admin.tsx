import { AdminUsersPanel } from "./admin-users";
import { adminAccessError } from "@/lib/admin-access";
import { useCallback, useEffect, useState } from "react";
import { queryKeys } from "@/lib/queryKeys";
import { useQueryClient, useQuery, useIsFetching } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type APIError } from "@/api";
import { useMe } from "@/lib/hooks";
import { useTitle } from "@/lib/use-title";
import { Page, PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const number = (value: number) => value.toLocaleString();
export function AdminPage() {
  useTitle("Platform admin");
  const me = useMe();
  const qc = useQueryClient();
  const [view, setView] = useState<"users" | "overview">("users");
  const [accessError, setAccessError] = useState<APIError | null>(null);
  const onUnauthorized = useCallback((error: APIError) => setAccessError(error), []);
  const refreshing = useIsFetching({ queryKey: queryKeys.adminAll() }) > 0;
  const stats = useQuery({
    queryKey: queryKeys.adminStats(),
    queryFn: api.adminStats,
    enabled: me.data?.is_admin === true && accessError === null,
    retry: false,
    refetchInterval: 60000,
  });
  const authError = adminAccessError(stats.error) ?? accessError;
  const unauthorized = !!authError;
  const accessLost =
    unauthorized || me.unauth || (me.data !== undefined && me.data.is_admin !== true);
  useEffect(() => {
    if (!accessLost) return;
    if (unauthorized)
      qc.setQueryData<Awaited<ReturnType<typeof api.me>>>(queryKeys.me(), (current) =>
        current ? { ...current, is_admin: false } : current,
      );
    void qc
      .cancelQueries({ queryKey: queryKeys.adminAll() })
      .then(() => qc.removeQueries({ queryKey: queryKeys.adminAll() }));
    if (unauthorized) void qc.invalidateQueries({ queryKey: queryKeys.me() });
  }, [accessLost, unauthorized, qc]);
  if (me.unauth || authError?.status === 401)
    return (
      <Page>
        <PageHeader title="Session expired" description="Sign in again to continue." />
        <Link to="/login">Sign in</Link>
      </Page>
    );
  if (me.isLoading) return <Page>Loading…</Page>;
  if (unauthorized || !me.data?.is_admin)
    return (
      <Page>
        <PageHeader
          title="Admin access required"
          description="This dashboard is available to platform administrators."
        />
        <Link to="/app/documents">Back to documents</Link>
      </Page>
    );
  const data = stats.data;
  return (
    <Page>
      <PageHeader
        title="Platform admin"
        description="See who is using the platform and what they have uploaded."
        actions={
          <Button
            variant="outline"
            disabled={refreshing}
            onClick={() =>
              void qc.invalidateQueries({ queryKey: queryKeys.adminAll() })
            }
          >
            Refresh
          </Button>
        }
      />
      <div className="mb-6 flex gap-3">
        <Button
          variant={view === "users" ? "primary" : "outline"}
          aria-pressed={view === "users"}
          onClick={() => setView("users")}
        >
          Users and documents
        </Button>
        <Button
          variant={view === "overview" ? "primary" : "outline"}
          aria-pressed={view === "overview"}
          onClick={() => setView("overview")}
        >
          Overview
        </Button>
      </div>
      <div hidden={view !== "users"}>
        <AdminUsersPanel active={view === "users"} onUnauthorized={onUnauthorized} />
      </div>
      {view === "overview" && stats.isError && (
        <p role="alert" className="mb-6">
          Could not load statistics. Try refreshing.
        </p>
      )}
      {view === "overview" && stats.isLoading && <p>Loading statistics…</p>}
      {view === "overview" && data && (
        <div className="space-y-6">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Updated {new Date(stats.dataUpdatedAt).toLocaleTimeString()}. Activity
            tracking since {data.tracking_since}.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              [
                "Signed-up users",
                number(data.users),
                "Human accounts that completed sign-in; excludes invitations and bots.",
              ],
              [
                "Active in 24 hours",
                number(data.active_24h),
                "Distinct humans using API operations, including automatic document refreshes.",
              ],
              [
                "Active in 7 days",
                number(data.active_7d),
                "Distinct humans using API operations, including automatic document refreshes.",
              ],
              [
                "Active in 30 days",
                number(data.active_30d),
                "Distinct humans using API operations, including automatic document refreshes.",
              ],
              [
                "Logged-in users",
                number(data.logged_in_users),
                "Users with an unexpired browser session; this does not mean online now.",
              ],
              [
                "Browser sessions",
                number(data.sessions),
                "Unexpired sessions; a person can have several. Older Go sessions appear when next used; rotating its signing key excludes previous sessions.",
              ],
              ["Documents", number(data.documents), "Currently retained documents."],
              [
                "Uploaded versions",
                number(data.versions),
                "All retained document versions, including first uploads.",
              ],
              [
                "Stored HTML",
                `${number(data.storage_bytes)} bytes`,
                `Uploaded HTML across retained versions. ${data.unknown_size_versions ? `${number(data.unknown_size_versions)} older versions have unrecorded sizes. ` : ""}Excludes database and infrastructure overhead.`,
              ],
              ["Comments", number(data.comments), "Retained comments and replies."],
              [
                "Enabled bots",
                number(data.service_accounts),
                "Service accounts that have not been disabled.",
              ],
              [
                "API operations in 30 days",
                number(data.daily.reduce((sum, day) => sum + day.requests, 0)),
                "REST requests and API operations dispatched by MCP tools in the last 30 UTC calendar days. Excludes dashboard, presence, cursors, event streams, and rate-limit rejections.",
              ],
            ].map(([title, value, description]) => (
              <Card key={title} className="p-5">
                <h2 className="text-sm font-medium">{title}</h2>
                <p className="my-2 text-3xl font-semibold tabular-nums">{value}</p>
                <p className="text-sm text-[var(--color-fg-muted)]">{description}</p>
              </Card>
            ))}
          </div>
          <Card className="overflow-x-auto p-5">
            <h2 className="mb-4 text-lg font-medium">Daily usage · last 30 UTC days</h2>
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="pb-3">Date (UTC)</th>
                  <th className="pb-3">API operations</th>
                  <th className="pb-3">Active users</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 30 }, (_, index) => {
                  const date = new Date();
                  date.setUTCDate(date.getUTCDate() - index);
                  const day = date.toISOString().slice(0, 10);
                  const row = data.daily.find((item) => item.day === day);
                  const tracked = day >= data.tracking_since;
                  return (
                    <tr key={day} className="border-t border-[var(--color-border)]">
                      <td className="py-3">{day}</td>
                      <td>{tracked ? number(row?.requests ?? 0) : "—"}</td>
                      <td>{tracked ? number(row?.active_users ?? 0) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
              Activity measures authenticated API traffic, including failed authorized
              operations. It excludes anonymous traffic, render delivery, and
              infrastructure costs. A dash means the day predates tracking.
            </p>
          </Card>
        </div>
      )}
    </Page>
  );
}
