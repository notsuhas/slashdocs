package repo

import (
	"context"
	"time"

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
	AdminUsers(context.Context, string, string, string, int) (AdminUserPage, error)
	AdminUserDocuments(context.Context, string, string, string, int) (AdminDocumentPage, error)
}
type AdminObservations interface {
	RecordActivity(context.Context, string, bool) error
	ObserveSession(context.Context, auth.VerifiedSession) error
	ForgetSession(context.Context, auth.VerifiedSession) error
	FlushAdminActivity(context.Context) error
	PruneAdminObservations(context.Context) error
}

type AdminUser struct {
	ID                string     `json:"id"`
	Email             string     `json:"email"`
	Name              string     `json:"name"`
	PictureURL        string     `json:"picture_url"`
	CreatedAt         time.Time  `json:"created_at"`
	LastLoginAt       *time.Time `json:"last_login_at"`
	LastActiveAt      *time.Time `json:"last_active_at"`
	Sessions          int64      `json:"sessions"`
	DocumentsUploaded int64      `json:"documents_uploaded"`
	VersionsUploaded  int64      `json:"versions_uploaded"`
	OwnedDocuments    int64      `json:"owned_documents"`
	Requests30d       int64      `json:"requests_30d"`
}
type AdminUserPage struct {
	Items   []AdminUser `json:"items"`
	HasMore bool        `json:"has_more"`
}
type AdminDocument struct {
	ID                  string     `json:"id"`
	Title               string     `json:"title"`
	OwnerID             string     `json:"owner_id"`
	OwnerName           string     `json:"owner_name"`
	OwnerEmail          string     `json:"owner_email"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
	FirstUploadAt       *time.Time `json:"first_upload_at"`
	LastUploadAt        *time.Time `json:"last_upload_at"`
	VersionsUploaded    int64      `json:"versions_uploaded"`
	TotalVersions       int64      `json:"total_versions"`
	StorageBytes        int64      `json:"storage_bytes"`
	UnknownSizeVersions int64      `json:"unknown_size_versions"`
}
type AdminDocumentPage struct {
	Items   []AdminDocument `json:"items"`
	HasMore bool            `json:"has_more"`
}
