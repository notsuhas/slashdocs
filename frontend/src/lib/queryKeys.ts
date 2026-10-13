// React Query key factory. Keys share prefixes so related queries invalidate
// together.
export const queryKeys = {
  adminStats: () => ["admin-stats"] as const,
  me: () => ["me"] as const,
  config: () => ["config"] as const,
  documents: () => ["documents"] as const,
  document: (id: string) => ["document", id] as const,
  versions: (doc: string) => ["versions", doc] as const,
  render: (version: string) => ["render", version] as const,
  comments: (doc: string) => ["comments", doc] as const,
  serviceAccounts: () => ["service-accounts"] as const,
  serviceAccountKeys: (id: string) => ["service-account-keys", id] as const,
  // Prefix key matching every folder listing (root and nested alike); use it
  // to invalidate after moves and deletes that can touch any folder.
  foldersAll: () => ["folders"] as const,
  folders: (folderId?: string) => ["folders", folderId || "root"] as const,
  folder: (id: string) => ["folder", id] as const,
  // Prefix key matching folder access lists for every folder.
  folderAccessAll: () => ["folder-access"] as const,
  folderAccess: (id: string) => ["folder-access", id] as const,
  documentAccess: (id: string) => ["document-access", id] as const,
  pins: () => ["pins"] as const,
  featured: () => ["featured"] as const,
  userSearch: (query: string) => ["users", "search", query] as const,
};
