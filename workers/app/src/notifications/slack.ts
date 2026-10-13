export interface NotificationMessage {
  reason: string;
  link: string;
  documentTitle: string;
  highlight?: string;
  body?: string;
  requester?: string;
  previousRole?: string;
  role?: string;
  directAccess?: boolean;
  reply?: boolean;
}
export class DeliveryError extends Error {
  constructor(
    public code: string,
    public permanent = false,
    public retryAfter = 0,
  ) {
    super(`Slack delivery: ${code}`);
  }
}
export function notificationRetry(attempts: number, error: unknown): number {
  const delay = 2 ** Math.min(attempts, 8) * 1000;
  return error instanceof DeliveryError
    ? error.permanent
      ? 0
      : Math.max(delay, error.retryAfter)
    : delay;
}
export function notificationPreview(value: string, limit: number): string {
  const masked = value
    .replace(
      /\b(otp|one[ -]time (?:password|code)|verification code|password|api[ _-]?key|access[ _-]?token|cvv|cvc)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[redacted]",
    )
    .replace(
      /\b(otp|one[ -]time (?:password|code)|verification code)(\s+(?:is\s+)?)([0-9]{4,10})\b/gi,
      "$1$2[redacted]",
    )
    .replace(/\b(?:[0-9][ -]?){12,18}[0-9]\b/g, (value) => {
      const digits = value.replace(/[ -]/g, "");
      let sum = 0;
      for (let i = digits.length - 1; i >= 0; i--) {
        let n = Number(digits[i]);
        if ((digits.length - 1 - i) % 2 === 1) {
          n *= 2;
          if (n > 9) n -= 9;
        }
        sum += n;
      }
      return sum > 0 && sum % 10 === 0 ? "[redacted card number]" : value;
    });
  const chars = Array.from(masked.trim());
  return chars.length > limit
    ? chars.slice(0, limit - 1).join("") + "…"
    : chars.join("");
}
const text = (value: string) => ({ type: "text", text: value });
const bold = (value: string) => ({ ...text(value), style: { bold: true } });
const section = (elements: unknown[]) => ({ type: "rich_text_section", elements });
const rich = (elements: unknown[]) => ({ type: "rich_text", elements });
const button = (label: string, url: string) => ({
  type: "actions",
  elements: [
    {
      type: "button",
      text: { type: "plain_text", text: label, emoji: false },
      url,
      style: "primary",
    },
  ],
});
function roleLabel(role = "") {
  return ["viewer", "commenter", "editor", "owner"].includes(role)
    ? role[0].toUpperCase() + role.slice(1)
    : "None";
}
export function slackMessage(channel: string, message: NotificationMessage) {
  const title = notificationPreview(message.documentTitle, 150) || "Untitled document";
  const document = [
    text("Document: "),
    { type: "link", url: message.link, text: title, style: { bold: true } },
  ];
  let activity: string;
  let fallback: string[];
  let blocks: unknown[];
  if (message.reason.startsWith("access_")) {
    const label = message.directAccess ? "Direct access" : "Access";
    activity = "🔐 Your document access changed";
    let detail = `${label}: ${roleLabel(message.previousRole)} → ${roleLabel(message.role)}`;
    let buttonLabel = "Open document";
    switch (message.reason) {
      case "access_requested":
        activity = "🔑 Someone requested access to your document";
        detail = "Requested by: " + notificationPreview(message.requester ?? "", 300);
        buttonLabel = "Review access";
        break;
      case "access_shared":
        activity = message.directAccess
          ? "📄 A document was shared directly with you"
          : "📄 A document was shared with you";
        detail = `${label}: ${roleLabel(message.role)}`;
        break;
      case "access_removed":
        activity = message.directAccess
          ? "🔒 Your direct document access was removed"
          : "🔒 Your document access was removed";
        detail = `Previous ${label.toLowerCase()}: ${roleLabel(message.previousRole)}`;
        break;
    }
    blocks = [
      rich([section([bold(activity)])]),
      rich([section([...document, text("\n\n" + detail)])]),
    ];
    if (message.reason !== "access_removed")
      blocks.push(button(buttonLabel, message.link));
    fallback = [activity, "Document: " + title, detail, message.link];
  } else {
    const highlight = notificationPreview(message.highlight ?? "", 600);
    const body = notificationPreview(message.body ?? "", 2200);
    activity =
      message.reason === "mention"
        ? "🔔 Someone mentioned you in a comment"
        : message.reply
          ? "💬 Someone replied to a comment on your doc"
          : "💬 Someone commented on your doc";
    const elements: unknown[] = [section([...document, text("\n\n")])];
    fallback = [activity, "Document: " + title];
    if (highlight) {
      elements.push({
        type: "rich_text_quote",
        elements: [{ ...text(highlight), style: { italic: true } }],
      });
      fallback.push("> " + highlight.replaceAll("\n", "\n> "));
    }
    elements.push(section([text("\n" + body)]));
    blocks = [
      rich([section([bold(activity)])]),
      rich(elements),
      button("View comment", message.link),
    ];
    fallback.push(body, message.link);
  }
  return {
    channel,
    text: fallback.join("\n\n"),
    blocks,
    mrkdwn: false,
    parse: "none",
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  };
}
const statusErrors = new Set([
  "users_not_found",
  "user_not_found",
  "account_inactive",
  "cannot_dm_bot",
  "channel_not_found",
  "invalid_auth",
  "token_revoked",
  "missing_scope",
  "not_allowed_token_type",
]);
export type SlackHTTP = (input: string, init: RequestInit) => Promise<Response>;
export class SlackSender {
  constructor(
    private token: string,
    private http: SlackHTTP = fetch,
  ) {}
  private async call(
    method: string,
    payload: object | URLSearchParams,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      const http = this.http;
      response = await http("https://slack.com/api/" + method, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.token,
          "Content-Type":
            payload instanceof URLSearchParams
              ? "application/x-www-form-urlencoded"
              : "application/json; charset=utf-8",
        },
        body:
          payload instanceof URLSearchParams
            ? payload.toString()
            : JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new DeliveryError("transport");
    }
    if (response.status === 429)
      throw new DeliveryError(
        "rate_limited",
        false,
        Math.max(1, parseInt(response.headers.get("Retry-After") ?? "0", 10) || 0) *
          1000,
      );
    if (response.status !== 200)
      throw new DeliveryError(
        "http_" + response.status,
        response.status >= 400 && response.status < 500,
      );
    let raw: string;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (bytes < 1048576) {
        const next = await reader.read();
        if (next.done) break;
        const keep = next.value.subarray(0, 1048576 - bytes);
        chunks.push(keep);
        bytes += keep.length;
      }
      await reader.cancel();
      const data = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      raw = new TextDecoder().decode(data);
    } catch {
      throw new DeliveryError("response_read");
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new DeliveryError("invalid_response");
    }
    if (data === null) throw new DeliveryError("api_error");
    if (typeof data !== "object" || Array.isArray(data))
      throw new DeliveryError("invalid_response");
    if ("ok" in data && data.ok !== null && typeof data.ok !== "boolean")
      throw new DeliveryError("invalid_response");
    if ("error" in data && data.error !== null && typeof data.error !== "string")
      throw new DeliveryError("invalid_response");
    if (!("ok" in data) || !data.ok) {
      const code = "error" in data && typeof data.error === "string" ? data.error : "";
      throw new DeliveryError(
        statusErrors.has(code) ? code : "api_error",
        statusErrors.has(code),
      );
    }
    // Object shape was checked above. Spread obtains an indexable record without a cast.
    return Object.fromEntries(Object.entries(data));
  }
  async send(email: string, message: NotificationMessage) {
    const lookup = await this.call(
      "users.lookupByEmail",
      new URLSearchParams({ email }),
    );
    const user = lookup.user;
    if (user !== undefined && user !== null) {
      if (typeof user !== "object" || Array.isArray(user))
        throw new Error("Invalid Slack user response");
      for (const field of ["id", "deleted", "is_bot"]) {
        const value = Object.entries(user).find(([key]) => key === field)?.[1];
        if (
          value !== undefined &&
          value !== null &&
          typeof value !== (field === "id" ? "string" : "boolean")
        )
          throw new Error("Invalid Slack user response");
      }
    }
    if (
      typeof user !== "object" ||
      user === null ||
      !("id" in user) ||
      typeof user.id !== "string" ||
      !user.id ||
      ("deleted" in user && user.deleted) ||
      ("is_bot" in user && user.is_bot)
    )
      throw new DeliveryError("ineligible_user", true);
    const open = await this.call("conversations.open", { users: user.id });
    const channel = open.channel;
    if (
      typeof channel !== "object" ||
      channel === null ||
      !("id" in channel) ||
      typeof channel.id !== "string" ||
      !channel.id
    )
      throw new Error("Slack returned no direct message channel");
    await this.call("chat.postMessage", slackMessage(channel.id, message));
  }
}
export function documentURL(origin: string, documentID: string) {
  return origin.replace(/\/+$/, "") + "/app/d/" + encodeURIComponent(documentID);
}
