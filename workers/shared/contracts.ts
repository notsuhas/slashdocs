export type Principal = {
  type: "user" | "service_account" | "google_group" | "anyone";
  id: string;
  email?: string;
  name?: string;
  picture_url?: string;
};
export type CommentMentionPrincipal = Omit<Principal, "type"> & {
  type: "user" | "service_account";
};
export type CommentMentionPrincipalRef = Pick<CommentMentionPrincipal, "type" | "id">;
export type UserPrincipal = Omit<Principal, "type"> & { type: "user" };
export type CommentMention = {
  principal: CommentMentionPrincipal;
  offset: number;
  length: number;
};
export type Document = {
  id: string;
  title: string;
  owner?: Principal;
  current_version_id?: string;
  parent_folder_id?: string;
  parent_folder?: { id: string; title: string };
  updated_at?: string;
  labels?: string[];
  // Search results only: the matching text. U+0002 and U+0003 surround each match.
  snippet?: string;
};
export type ServerConfig = {
  deployment: "public" | "org";
  org_name: string;
  everyone_label: string;
  provider_name: string;
  google_groups_enabled: boolean;
  labels_enabled: boolean;
};
export type GoogleGroup = { id: string; email: string; name: string };
export type Version = {
  id: string;
  number: number;
  document_id?: string;
  created_by?: Principal;
  change_summary?: string;
  sha256?: string;
  created_at?: string;
};
export type GitHubStatus = {
  connected: boolean;
  configured: boolean;
  login?: string;
  avatar_url?: string;
};
export type GitHubRawRequest = {
  owner: string;
  repo: string;
  path: string;
  ref: string;
};
export type GitHubRawResponse = GitHubRawRequest & { content: string };
export type Anchor = {
  quote: string;
  prefix?: string;
  suffix?: string;
  dom_path?: string;
  start_offset?: number;
  end_offset?: number;
};
// REACTION_EMOJI is the closed set the server accepts. Values are stable ASCII
// slugs rather than literal emoji, so each client picks its own glyph.
export const REACTION_EMOJI = [
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
  "plus",
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];
export type CommentReaction = {
  emoji: string;
  count: number;
  reacted: boolean;
  // Optional when reading from a server that predates reactor identities.
  reactors?: Principal[];
};
export type Comment = {
  id: string;
  body: string;
  selected_text?: string;
  status: string;
  author: Principal;
  created_on_version_id: string;
  parent_comment_id?: string;
  root_comment_id?: string;
  // Optional only for rolling-upgrade reads from an older server. New servers
  // always return an array, including when it is empty.
  mentions?: CommentMention[];
  // Optional for the same reason as mentions.
  reactions?: CommentReaction[];
  anchor?: Anchor;
  replies?: Comment[];
  current_placement?: {
    status: string;
    confidence: number;
    matched_text: string;
  };
  created_at?: string;
  resolved_at?: string;
};
export type CommentPatch = {
  body?: string;
  status?: string;
  mentions?: CommentMention[];
};

export type Grant = {
  id: string;
  principal?: Principal;
  role: string;
};
export type FolderBreadcrumb = {
  id: string;
  title: string;
};

export type Folder = {
  id: string;
  title: string;
  owner?: Principal;
  parent_folder_id?: string;
  ancestors?: FolderBreadcrumb[];
};
export type FolderEntry = {
  type: "folder" | "document";
  folder?: Folder;
  document?: Document;
  last_active?: string;
};
// FeaturedSection is a titled row of server-configured documents and folders.
// Users cannot hide the items of a permanent section.
export type FeaturedSection = {
  title: string;
  description?: string;
  permanent: boolean;
  items: FolderEntry[];
};
export type Pin = {
  resource_type: "document" | "folder";
  resource_id: string;
};
export type DocumentKVSnapshot = {
  revision: number;
  items: Record<string, unknown>;
};
export type DocumentKVChange = {
  key: string;
  value?: unknown;
  deleted?: boolean;
  revision: number;
  updated_at?: string;
  updated_by?: Principal;
  operation?: string;
};
export type DocumentKVPatch = {
  set?: Record<string, unknown>;
  delete?: string[];
};
export type DocumentKVPatchResult = {
  revision: number;
  changes: DocumentKVChange[];
  updated_by?: Principal;
};
export type DocumentKVEvent = {
  document_id: string;
  revision: number;
  changes: DocumentKVChange[];
  updated_at?: string;
  updated_by?: Principal;
  // Stream events other than KV changes set kind; presence events carry data.
  kind?: "kv" | "document" | "comments" | "presence";
  data?: unknown;
};
// A viewer's place in a document, published on the document event stream.
export type DocumentPresence = {
  session: string;
  version?: string;
  anchor?: Partial<Anchor>;
  left?: boolean;
  picture_url?: string;
};
export type AccessSource = {
  resource_type: string;
  resource_id: string;
  resource_title: string;
  role: string;
  grant_id?: string;
};
export type EffectiveAccessItem = {
  principal: Principal;
  effective_role: string;
  sources: AccessSource[];
};
export type ServiceAccount = {
  id: string;
  name: string;
  disabled?: boolean;
  owner?: Principal;
};
export type ServiceAccountKey = { id: string; name: string };
