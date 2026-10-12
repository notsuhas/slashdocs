# Folder, workspace, pins, and featured parity

Contract audited against upstream commit `6ccc967`. This document contains only generic schema and behavior; it contains no instance configuration or credentials.

## REST contracts

| Method and route                                  | Input                             | Output                                                         |
| ------------------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| POST `/v1/folders`                                | `{title,parent_folder_id?}`       | 201 Folder                                                     |
| GET `/v1/folders`                                 | `folder_id`, `path`, or `q` query | `{folder:Folder                                                | null,items:FolderEntry[],has_more:boolean}`             |
| GET `/v1/folders/:id`                             |                                   | Folder with visible ancestor breadcrumbs                       |
| PATCH `/v1/folders/:id`                           | `{title?,parent_folder_id?:string | null}`                                                         | `{id,title,owner,parent_folder_id,permission_warning?}` |
| DELETE `/v1/folders/:id`                          |                                   | 204                                                            |
| GET `/v1/folders/:id/access`                      |                                   | `{items:EffectiveAccessItem[],current_role}`                   |
| POST `/v1/folders/:id/grants`                     | canonical grant input             | 201 Grant                                                      |
| PATCH `/v1/folders/:id/grants/:grant_id`          | `{role}`                          | Grant                                                          |
| DELETE `/v1/folders/:id/grants/:grant_id`         |                                   | 204                                                            |
| GET `/v1/folders/:id/documents`                   |                                   | `{items:Document[]}`                                           |
| POST `/v1/folders/:id/documents`                  | `{document_id}`                   | `{document_id,folder_id,moved:true,permission_warning?}`       |
| DELETE `/v1/folders/:id/documents/:doc_id`        |                                   | 204, move matching document to root                            |
| GET `/v1/pins`                                    |                                   | `{items:[{resource_type,resource_id}]}`                        |
| PUT/DELETE `/v1/pins/:resource_type/:resource_id` |                                   | 204                                                            |
| GET `/v1/featured`                                |                                   | `{items:[{title,description?,permanent,items:FolderEntry[]}]}` |
| DELETE `/v1/featured/:id`                         |                                   | 204 for configured nonpermanent item, otherwise 404            |

Folder: `{id,title,owner,parent_folder_id?,ancestors?:[{id,title}]}`. FolderEntry: `{type:'folder',folder,last_active?}` or `{type:'document',document}`. Parent folder omission means root on Folder/Document reads; PATCH folder always returns `parent_folder_id` including empty root. Warning: `{kind:'may_broaden_access',message}`. Ambiguous root path: 409 `{error:{code:'ambiguous_path',message},candidates:Folder[]}`.

## Access rules

Only resource grants inherit. Ownership applies to its exact document or folder; ancestor ownership grants no role on somebody else's children. Effective role is maximum of direct/inherited active grants and exact ownership. Folder grants apply to the folder and descendants. Canonical grant roles are viewer, commenter, editor; owner remains an ownership field.

Folder resource reads and listing a parent require viewer on that parent. Once authorized, child folder/document listings return all immediate child metadata, including foreign-owned private children. Metadata visibility does not authorize child GET or body mutation; ownership never inherits. Folder GET returns the same 403 viewer denial for private and missing IDs. Create under parent requires editor on parent. Folder rename/move/delete requires exact owner; move also requires editor on destination. Grant management requires commenter. Document move requires editor on document and destination, plus editor on source unless document owner or destination equals source. Moving root has no destination role requirement.

Sharing report includes exact owner once, then active direct/inherited grant sources grouped by principal with highest role. Ancestor owners do not appear as inherited owners. Each source includes resource type, ID, title, role, optional grant ID. The caller's role is independent of reported principal roles.

Get-folder ancestor breadcrumbs retain only the contiguous accessible suffix, root-first. Opening someone else's accessible folder records workspace recency. Workspace rows are never authorization: revoked access must remove metadata from root results even if an opened row persists.

## Tree and deletion invariants

Depth limit is 15 folders counting root. A move must check destination depth plus whole subtree height. Reject self-parent and descendant-parent moves. Child titles are case-insensitively unique across all owners within the parent; root titles are case-insensitively unique per owner. Absent PATCH parent leaves placement unchanged; null and empty string move to root.

Delete traverses only folders owned by deleting principal, stopping at other owners. Kept foreign-owned boundary folders move to their owners' roots, preserving their subtrees; collision titles receive ` (2)`, ` (3)`, etc. Documents survive and move root when containing folder is deleted. Folder-structure writes and their invariant checks must occur atomically, including concurrent reciprocal moves.

## Workspace, search, and featured

Root workspace includes owned roots, explicitly principal/group-shared roots, and opened anyone-shared roots. Opened nested folders appear when currently accessible and no opened ancestor already represents them. Root sorting is opened/created recency descending. Child folder sorting is title. Root/child queries fetch at most 51 rows and emit at most 50; upstream `has_more` is true at exactly 50. Title search emits at most 25, `has_more` true at exactly 25. Search recursively expands every owned or directly granted folder, including foreign-owned descendants of owned ancestors, and returns metadata without conferring resource access; anyone-wide discovery is org deployment only.

Path segments match titles using the stored `title_key`, derived by JavaScript Unicode `toLowerCase()` on create and title update. Unique indexes, path lookup, search and foreign-boundary collision suffix triggers use that same key; SQLite ASCII `lower()` is not used as a title key. This matches accented upper/lower pairs such as Équipe/équipe; it is not Unicode normalization or a claim of equivalence across every PostgreSQL deployment locale. Child path resolution trusts the final parent authorization just as Go does. Multiple accessible matching root titles return ambiguous candidates; exact child title is unique. Bound paths to the supported tree depth. Folder children documents retain canonical Document DTOs.

Featured config is an ordered object mapping section titles to `{description?,permanent?,items:IDs[]}`. Validate nonempty trimmed titles, nonempty item arrays, document/folder ID prefixes, and unknown keys. Resolve configured IDs with current access, omit missing/inaccessible entries and empty sections, preserve configured order. Hidden rows are per principal; permanent section ignores hidden state, even when the same ID also occurs in a hideable section.

## Bounded D1 interfaces and schema

Use one recursive CTE for folder access chain, returning at most 15 root-first rows with effective roles. Reuse a SQL visibility predicate with explicit bindings for listings, write guards, pins, and featured selection; avoid per-entry queries. Hydrate principals with bounded bulk joins, and include document parent breadcrumbs in joined document DTOs.

Required schema: folders with polymorphic owner type/ID, parent FK `ON DELETE SET NULL`, timestamps and sibling indexes; documents nullable parent FK and index; folder workspace entries keyed by folder and principal; folder grants or canonical polymorphic resource grants with principal type/ID, role, creator, revocation and relevant indexes; polymorphic principal pins; hidden featured items per principal/resource. Preserve existing document pin data when rebuilding its document-only constrained table. Service-account and Google-group identities must use the same canonical identity model as documents and authentication.

Tests must execute actual D1 SQL via Miniflare: inheritance monotonicity, ownership isolation, revoked opened-item metadata, breadcrumb privacy, access provenance, title uniqueness, depth and concurrent cycle prevention, subtree deletion/foreign boundaries/collisions, document move source protection/owner escape, polymorphic pins and featured hide/permanent visibility.

## Verification and remaining integration

Real D1 regressions pair unrestricted metadata listing/search with denied child resource reads and mutations; private/missing GET denial; Unicode root/child duplicates, rename, paths, search, private root ambiguity and multiple foreign-boundary collision suffixes; concurrent create/reparent at depth 15; source/destination/document editor revocation between prechecks and the move SQL; mixed featured document/folder batches above 90 IDs and revoked pins.

Google Groups remain a root integration dependency. Folder group-grant creation currently returns `503 google_group_unavailable`; group expansion in permissions, workspace and search is not complete. Service accounts use backing user identities with provider `service_account`, while folder DTOs use the stored `owner_type`. No full-parity claim should be made until the group integration and whole application checks pass.
