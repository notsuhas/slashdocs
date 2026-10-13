package postgres

import (
	"context"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

func (s *Store) RecordActivity(ctx context.Context, id string, user bool) error {
	_, err := s.db.Exec(ctx, `INSERT INTO admin_activity(day,principal_id,is_user) VALUES ((now() AT TIME ZONE 'UTC')::date,$1,$2) ON CONFLICT(day,principal_id) DO UPDATE SET requests=admin_activity.requests+1,last_seen=now()`, id, user)
	return err
}
func (s *Store) ObserveSession(ctx context.Context, hash, user string, expiry int64) error {
	_, err := s.db.Exec(ctx, `INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES($1,$2,to_timestamp($3)) ON CONFLICT(token_hash) DO NOTHING`, hash, user, expiry)
	return err
}
func (s *Store) ForgetSession(ctx context.Context, hash string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM admin_sessions WHERE token_hash=$1`, hash)
	return err
}
func (s *Store) AdminStats(ctx context.Context) (repo.AdminStats, error) {
	out := repo.AdminStats{Daily: []repo.AdminDay{}}
	err := s.db.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM users WHERE google_sub IS NOT NULL),
 (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user AND last_seen>now()-interval '24 hours'),
 (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user AND last_seen>now()-interval '7 days'),
 (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user AND last_seen>now()-interval '30 days'),
 (SELECT count(DISTINCT user_id) FROM admin_sessions WHERE expires_at>now()),
 (SELECT count(*) FROM admin_sessions WHERE expires_at>now()),
 (SELECT count(*) FROM documents), (SELECT count(*) FROM versions),
 (SELECT coalesce(sum(byte_length),0) FROM versions),
 (SELECT count(*) FROM versions WHERE byte_length IS NULL),
 (SELECT count(*) FROM comments),
 (SELECT count(*) FROM service_accounts WHERE disabled_at IS NULL),
 (SELECT min(day)::text FROM admin_activity)`).Scan(&out.Users, &out.Active24h, &out.Active7d, &out.Active30d, &out.LoggedInUsers, &out.Sessions, &out.Documents, &out.Versions, &out.StorageBytes, &out.UnknownSizeVersions, &out.Comments, &out.ServiceAccounts, &out.TrackingSince)
	if err != nil {
		return out, err
	}
	rows, err := s.db.Query(ctx, `SELECT day::text,sum(requests),count(*) FILTER (WHERE is_user) FROM admin_activity WHERE day >= (now() AT TIME ZONE 'UTC')::date-29 GROUP BY day ORDER BY day DESC`)
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
