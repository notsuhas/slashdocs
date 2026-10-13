import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { useMe } from "@/lib/hooks";
import { useTitle } from "@/lib/use-title";
import { Page, PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const number = (value: number) => value.toLocaleString();
export function AdminPage() {
  useTitle("Admin statistics");
  const me = useMe();
  const stats = useQuery({
    queryKey: ["admin-stats"],
    queryFn: api.adminStats,
    enabled: me.data?.is_admin === true,
    retry: false,
    refetchInterval: 60000,
  });
  if (me.isLoading) return <Page>Loading…</Page>;
  if (!me.data?.is_admin)
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
        title="Platform statistics"
        description="Usage and adoption across the entire platform. Refreshes every minute."
        actions={
          <Button
            variant="outline"
            disabled={stats.isFetching}
            onClick={() => void stats.refetch()}
          >
            Refresh
          </Button>
        }
      />
      {stats.isError && (
        <p role="alert" className="mb-6">
          Could not load statistics. Try refreshing.
        </p>
      )}
      {stats.isLoading && <p>Loading statistics…</p>}
      {data && (
        <div className="space-y-6">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Updated {new Date(stats.dataUpdatedAt).toLocaleTimeString()}. Activity
            tracking{" "}
            {data.tracking_since
              ? `since ${data.tracking_since}`
              : "has no recorded requests yet"}
            .
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
                "Distinct humans making authenticated API requests.",
              ],
              [
                "Active in 7 days",
                number(data.active_7d),
                "Distinct humans making authenticated API requests.",
              ],
              [
                "Active in 30 days",
                number(data.active_30d),
                "Distinct humans making authenticated API requests.",
              ],
              [
                "Logged-in users",
                number(data.logged_in_users),
                "Users with an unexpired browser session; this does not mean online now.",
              ],
              [
                "Browser sessions",
                number(data.sessions),
                "Unexpired observed sessions; a person can have several.",
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
                "Requests in 30 days",
                number(data.daily.reduce((sum, day) => sum + day.requests, 0)),
                "Authenticated API requests in the last 30 UTC calendar days, including bots. Dashboard requests are excluded.",
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
                  <th className="pb-3">API requests</th>
                  <th className="pb-3">Active users</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 30 }, (_, index) => {
                  const date = new Date();
                  date.setUTCDate(date.getUTCDate() - index);
                  const day = date.toISOString().slice(0, 10);
                  const row = data.daily.find((item) => item.day === day);
                  const tracked =
                    data.tracking_since !== null && day >= data.tracking_since;
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
