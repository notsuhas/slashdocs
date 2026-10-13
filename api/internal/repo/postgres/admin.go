package postgres

import (
	"context"
	"errors"
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
	seen map[string]string
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
	for key, count := range pending {
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
	seen := s.adminSessions.seen[session.TokenHash] == session.SigningKeyID
	s.adminSessions.Unlock()
	if seen {
		return nil
	}
	_, err := s.db.Exec(ctx, `INSERT INTO admin_sessions(token_hash,user_id,expires_at,signing_key_id) VALUES($1,$2,to_timestamp($3),$4) ON CONFLICT(token_hash) DO UPDATE SET signing_key_id=excluded.signing_key_id`, session.TokenHash, session.UserID, session.ExpiresAt, session.SigningKeyID)
	if err != nil {
		return err
	}
	s.adminSessions.Lock()
	defer s.adminSessions.Unlock()
	if s.adminSessions.seen == nil || len(s.adminSessions.seen) >= maxObservedSessions {
		s.adminSessions.seen = make(map[string]string)
	}
	s.adminSessions.seen[session.TokenHash] = session.SigningKeyID
	return nil
}
func (s *Store) ForgetSession(ctx context.Context, hash string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM admin_sessions WHERE token_hash=$1`, hash)
	s.adminSessions.Lock()
	delete(s.adminSessions.seen, hash)
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
 (SELECT count(DISTINCT user_id) FROM admin_sessions WHERE expires_at>now() AND signing_key_id=$1),
 (SELECT count(*) FROM admin_sessions WHERE expires_at>now() AND signing_key_id=$1),
 (SELECT count(*) FROM documents),(SELECT count(*) FROM versions),
 (SELECT coalesce(sum(byte_length),0) FROM versions),
 (SELECT count(*) FROM versions WHERE byte_length IS NULL),
 (SELECT count(*) FROM comments),
 (SELECT count(*) FROM service_accounts WHERE disabled_at IS NULL),
 (SELECT (tracking_started_at AT TIME ZONE 'UTC')::date::text FROM admin_metadata WHERE id=1)`, keyID).Scan(&out.Users, &out.Active24h, &out.Active7d, &out.Active30d, &out.LoggedInUsers, &out.Sessions, &out.Documents, &out.Versions, &out.StorageBytes, &out.UnknownSizeVersions, &out.Comments, &out.ServiceAccounts, &out.TrackingSince)
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
