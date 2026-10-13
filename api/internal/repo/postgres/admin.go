package postgres

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const maxPendingPrincipals = 4096
const maxObservedSessions = 4096

type activityKey struct{ day, principal string }
type activityCount struct {
	user     bool
	requests int64
	lastSeen time.Time
}
type activityBuffer struct {
	sync.Mutex
	flush   sync.Mutex
	pending map[activityKey]activityCount
}
type sessionCache struct {
	sync.Mutex
	seen map[string]struct{}
}

// RecordActivity only updates a bounded in-memory buffer. Database work belongs
// to FlushAdminActivity, called periodically and when the dashboard is read.
func (s *Store) RecordActivity(_ context.Context, id string, user bool) error {
	now := time.Now().UTC()
	key := activityKey{day: now.Format("2006-01-02"), principal: id}
	s.adminActivity.Lock()
	defer s.adminActivity.Unlock()
	if s.adminActivity.pending == nil {
		s.adminActivity.pending = make(map[activityKey]activityCount)
	}
	count, exists := s.adminActivity.pending[key]
	if !exists && len(s.adminActivity.pending) >= maxPendingPrincipals {
		return errors.New("admin activity buffer is full")
	}
	count.user = user
	count.requests++
	count.lastSeen = now
	s.adminActivity.pending[key] = count
	return nil
}
func (s *Store) FlushAdminActivity(ctx context.Context) error {
	s.adminActivity.flush.Lock()
	defer s.adminActivity.flush.Unlock()
	s.adminActivity.Lock()
	pending := s.adminActivity.pending
	s.adminActivity.pending = make(map[activityKey]activityCount)
	s.adminActivity.Unlock()
	if len(pending) == 0 {
		return nil
	}
	batch := new(pgx.Batch)
	keys := make([]activityKey, 0, len(pending))
	for key := range pending {
		keys = append(keys, key)
	}
	// Every replica acquires row locks in the same order.
	slices.SortFunc(keys, func(a, b activityKey) int {
		if a.day < b.day || (a.day == b.day && a.principal < b.principal) {
			return -1
		}
		if a == b {
			return 0
		}
		return 1
	})
	for _, key := range keys {
		count := pending[key]
		batch.Queue(`INSERT INTO admin_activity(day,principal_id,is_user,requests,last_seen) VALUES($1,$2,$3,$4,$5) ON CONFLICT(day,principal_id) DO UPDATE SET requests=admin_activity.requests+excluded.requests,last_seen=greatest(admin_activity.last_seen,excluded.last_seen)`, key.day, key.principal, count.user, count.requests, count.lastSeen)
	}
	err := s.db.SendBatch(ctx, batch).Close()
	if err != nil {
		s.adminActivity.Lock()
		defer s.adminActivity.Unlock()
		for key, count := range pending {
			current, exists := s.adminActivity.pending[key]
			if !exists && len(s.adminActivity.pending) >= maxPendingPrincipals {
				continue
			}
			current.user = count.user
			current.requests += count.requests
			if current.lastSeen.Before(count.lastSeen) {
				current.lastSeen = count.lastSeen
			}
			s.adminActivity.pending[key] = current
		}
	}
	return err
}
func (s *Store) ObserveSession(ctx context.Context, session auth.VerifiedSession) error {
	s.adminSessions.Lock()
	_, seen := s.adminSessions.seen[session.TokenHash]
	s.adminSessions.Unlock()
	if seen {
		return nil
	}
	_, err := s.db.Exec(ctx, `INSERT INTO admin_sessions(token_hash,user_id,expires_at,signing_key_id) VALUES($1,$2,to_timestamp($3),$4) ON CONFLICT(token_hash) DO NOTHING`, session.TokenHash, session.UserID, session.ExpiresAt, session.SigningKeyID)
	if err != nil {
		return err
	}
	s.adminSessions.Lock()
	defer s.adminSessions.Unlock()
	if s.adminSessions.seen == nil || len(s.adminSessions.seen) >= maxObservedSessions {
		s.adminSessions.seen = make(map[string]struct{})
	}
	s.adminSessions.seen[session.TokenHash] = struct{}{}
	return nil
}
func (s *Store) ForgetSession(ctx context.Context, session auth.VerifiedSession) error {
	_, err := s.db.Exec(ctx, `INSERT INTO admin_sessions(token_hash,user_id,expires_at,signing_key_id,revoked_at) VALUES($1,$2,to_timestamp($3),$4,now()) ON CONFLICT(token_hash) DO UPDATE SET revoked_at=now()`, session.TokenHash, session.UserID, session.ExpiresAt, session.SigningKeyID)
	s.adminSessions.Lock()
	delete(s.adminSessions.seen, session.TokenHash)
	s.adminSessions.Unlock()
	return err
}
func (s *Store) PruneAdminObservations(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `DELETE FROM admin_activity WHERE day<(now() AT TIME ZONE 'UTC')::date-30; DELETE FROM admin_sessions WHERE expires_at<=now()`)
	return err
}
func (s *Store) AdminStats(ctx context.Context, keyID string) (repo.AdminStats, error) {
	out := repo.AdminStats{Daily: []repo.AdminDay{}}
	if err := s.FlushAdminActivity(ctx); err != nil {
		return out, err
	}
	err := s.db.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM users WHERE google_sub IS NOT NULL),
 (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user AND day>=(now() AT TIME ZONE 'UTC')::date-1 AND last_seen>now()-interval '24 hours'),
 (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user AND day>=(now() AT TIME ZONE 'UTC')::date-7 AND last_seen>now()-interval '7 days'),
 (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user AND day>=(now() AT TIME ZONE 'UTC')::date-30 AND last_seen>now()-interval '30 days'),
 (SELECT count(DISTINCT user_id) FROM admin_sessions WHERE expires_at>now() AND revoked_at IS NULL AND signing_key_id=$1),
 (SELECT count(*) FROM admin_sessions WHERE expires_at>now() AND revoked_at IS NULL AND signing_key_id=$1),
 (SELECT count(*) FROM documents),v.versions,v.storage_bytes,v.unknown_size_versions,
 (SELECT count(*) FROM comments),
 (SELECT count(*) FROM service_accounts WHERE disabled_at IS NULL),
 (SELECT (tracking_started_at AT TIME ZONE 'UTC')::date::text FROM admin_metadata WHERE id=1)
 FROM (SELECT count(*) AS versions,coalesce(sum(byte_length),0) AS storage_bytes,count(*) FILTER(WHERE byte_length IS NULL) AS unknown_size_versions FROM versions) v`, keyID).Scan(&out.Users, &out.Active24h, &out.Active7d, &out.Active30d, &out.LoggedInUsers, &out.Sessions, &out.Documents, &out.Versions, &out.StorageBytes, &out.UnknownSizeVersions, &out.Comments, &out.ServiceAccounts, &out.TrackingSince)
	if err != nil {
		return out, err
	}
	rows, err := s.db.Query(ctx, `SELECT day::text,sum(requests),count(*) FILTER(WHERE is_user) FROM admin_activity WHERE day>=(now() AT TIME ZONE 'UTC')::date-29 GROUP BY day ORDER BY day DESC`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var d repo.AdminDay
		if err := rows.Scan(&d.Day, &d.Requests, &d.ActiveUsers); err != nil {
			return out, err
		}
		out.Daily = append(out.Daily, d)
	}
	return out, rows.Err()
}

func (s *Store) AdminUsers(ctx context.Context, keyID, search, status string, page int) (repo.AdminUserPage, error) {
	out := repo.AdminUserPage{Items: []repo.AdminUser{}}
	if err := s.FlushAdminActivity(ctx); err != nil {
		return out, err
	}
	rows, err := s.db.Query(ctx, `WITH selected AS (
 SELECT u.* FROM users u WHERE google_sub IS NOT NULL
 AND ($2='' OR strpos(lower(u.email),lower($2))>0 OR strpos(lower(u.name),lower($2))>0)
 AND ($3<>'logged_in' OR EXISTS(SELECT 1 FROM admin_sessions s WHERE s.user_id=u.id AND s.expires_at>now() AND s.revoked_at IS NULL AND s.signing_key_id=$1))
 AND ($3<>'active' OR EXISTS(SELECT 1 FROM admin_activity a WHERE a.principal_id=u.id AND a.is_user AND a.day>=(now() AT TIME ZONE 'UTC')::date-1 AND a.last_seen>now()-interval '24 hours'))
 ORDER BY u.created_at DESC,u.id DESC LIMIT 26 OFFSET $4)
 SELECT u.id,u.email,u.name,u.picture_url,u.created_at,u.last_login_at,
 (SELECT max(last_seen) FROM admin_activity a WHERE a.principal_id=u.id AND a.is_user AND a.day>=(now() AT TIME ZONE 'UTC')::date-30),
 (SELECT count(*) FROM admin_sessions s WHERE s.user_id=u.id AND s.expires_at>now() AND s.revoked_at IS NULL AND s.signing_key_id=$1),
 (SELECT count(DISTINCT document_id) FROM versions v WHERE v.created_by_type='user' AND v.created_by_id=u.id),
 (SELECT count(*) FROM versions v WHERE v.created_by_type='user' AND v.created_by_id=u.id),
 (SELECT count(*) FROM documents d WHERE d.owner_id=u.id),
 (SELECT coalesce(sum(requests),0) FROM admin_activity a WHERE a.principal_id=u.id AND a.is_user AND a.day>=(now() AT TIME ZONE 'UTC')::date-29)
 FROM selected u ORDER BY u.created_at DESC,u.id DESC`, keyID, search, status, (page-1)*25)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var u repo.AdminUser
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.PictureURL, &u.CreatedAt, &u.LastLoginAt, &u.LastActiveAt, &u.Sessions, &u.DocumentsUploaded, &u.VersionsUploaded, &u.OwnedDocuments, &u.Requests30d); err != nil {
			return out, err
		}
		out.Items = append(out.Items, u)
	}
	if len(out.Items) > 25 {
		out.HasMore = true
		out.Items = out.Items[:25]
	}
	return out, rows.Err()
}
func (s *Store) AdminUserDocuments(ctx context.Context, id, kind, search string, page int) (repo.AdminDocumentPage, error) {
	out := repo.AdminDocumentPage{Items: []repo.AdminDocument{}}
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND google_sub IS NOT NULL)`, id).Scan(&exists); err != nil {
		return out, err
	}
	if !exists {
		return out, repo.ErrNotFound
	}
	rows, err := s.db.Query(ctx, `SELECT d.id,d.title,o.id,o.name,o.email,min(v.created_at),d.updated_at,
 min(v.created_at) FILTER(WHERE v.created_by_type='user' AND v.created_by_id=$1),
 max(v.created_at) FILTER(WHERE v.created_by_type='user' AND v.created_by_id=$1),
 count(*) FILTER(WHERE v.created_by_type='user' AND v.created_by_id=$1),count(*),
 coalesce(sum(v.byte_length) FILTER(WHERE v.created_by_type='user' AND v.created_by_id=$1),0),
 count(*) FILTER(WHERE v.created_by_type='user' AND v.created_by_id=$1 AND v.byte_length IS NULL)
 FROM documents d JOIN users o ON o.id=d.owner_id JOIN versions v ON v.document_id=d.id
 WHERE ($2<>'owned' OR d.owner_id=$1) AND ($2<>'uploaded' OR EXISTS(SELECT 1 FROM versions own WHERE own.document_id=d.id AND own.created_by_type='user' AND own.created_by_id=$1))
 AND ($3='' OR strpos(lower(d.title),lower($3))>0 OR d.id=$3)
 GROUP BY d.id,o.id ORDER BY d.updated_at DESC,d.id DESC LIMIT 26 OFFSET $4`, id, kind, search, (page-1)*25)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var d repo.AdminDocument
		if err := rows.Scan(&d.ID, &d.Title, &d.OwnerID, &d.OwnerName, &d.OwnerEmail, &d.CreatedAt, &d.UpdatedAt, &d.FirstUploadAt, &d.LastUploadAt, &d.VersionsUploaded, &d.TotalVersions, &d.StorageBytes, &d.UnknownSizeVersions); err != nil {
			return out, err
		}
		out.Items = append(out.Items, d)
	}
	if len(out.Items) > 25 {
		out.HasMore = true
		out.Items = out.Items[:25]
	}
	return out, rows.Err()
}
