package repo

import (
	"context"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

type AdminDay struct {
	Day         string `json:"day"`
	Requests    int64  `json:"requests"`
	ActiveUsers int64  `json:"active_users"`
}
type AdminStats struct {
	Users               int64      `json:"users"`
	Active24h           int64      `json:"active_24h"`
	Active7d            int64      `json:"active_7d"`
	Active30d           int64      `json:"active_30d"`
	LoggedInUsers       int64      `json:"logged_in_users"`
	Sessions            int64      `json:"sessions"`
	Documents           int64      `json:"documents"`
	Versions            int64      `json:"versions"`
	StorageBytes        int64      `json:"storage_bytes"`
	UnknownSizeVersions int64      `json:"unknown_size_versions"`
	Comments            int64      `json:"comments"`
	ServiceAccounts     int64      `json:"service_accounts"`
	TrackingSince       string     `json:"tracking_since"`
	Daily               []AdminDay `json:"daily"`
}
type AdminStatistics interface {
	AdminStats(context.Context, string) (AdminStats, error)
}
type AdminObservations interface {
	RecordActivity(context.Context, string, bool) error
	ObserveSession(context.Context, auth.VerifiedSession) error
	ForgetSession(context.Context, auth.VerifiedSession) error
	FlushAdminActivity(context.Context) error
	PruneAdminObservations(context.Context) error
}
