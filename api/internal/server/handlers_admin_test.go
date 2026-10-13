package server_test

import (
	"context"
	"encoding/json"
	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
	"net/http"
	"testing"
	"time"
)

func TestAdminAuthorizationAndStats(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AdminUsers: []string{" OWNER@EXAMPLE.COM "}, SessionSecret: oauthTestSigningMaterial})
	for _, p := range []auth.Principal{fixtureViewer, {Type: auth.PrincipalServiceAccount, ID: e.sa.ID, Email: fixtureOwner.Email}} {
		r := do(t, e.h, http.MethodGet, "/v1/admin/stats", "", map[string]string{"X-Test-Principal": principalHeader(p)})
		if r.Code != 403 {
			t.Fatalf("non-admin status=%d: %s", r.Code, r.Body.String())
		}
	}
	r := do(t, e.h, http.MethodGet, "/v1/admin/stats", "", nil)
	if r.Code != 401 {
		t.Fatalf("anonymous status=%d", r.Code)
	}
	headers := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)}
	r = do(t, e.h, http.MethodGet, "/v1/me", "", headers)
	var me struct {
		IsAdmin bool `json:"is_admin"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &me); err != nil || !me.IsAdmin {
		t.Fatalf("me: %s", r.Body.String())
	}
	ctx := context.Background()
	if err := e.store.ObserveSession(ctx, "valid", fixtureOwner.ID, time.Now().Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	if err := e.store.ObserveSession(ctx, "expired", fixtureViewer.ID, time.Now().Add(-time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	r = do(t, e.h, http.MethodGet, "/v1/admin/stats", "", headers)
	if r.Code != 200 {
		t.Fatalf("stats: %d %s", r.Code, r.Body.String())
	}
	if r.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal("cacheable admin stats")
	}
	var stats repo.AdminStats
	if err := json.Unmarshal(r.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats.Users != 7 || stats.Documents != 1 || stats.Versions != 1 || stats.Comments != 1 || stats.ServiceAccounts != 1 || stats.StorageBytes != int64(len("<html><body>fixture</body></html>")) || stats.UnknownSizeVersions != 0 || stats.LoggedInUsers != 1 || stats.Sessions != 1 || len(stats.Daily) != 1 || stats.Daily[0].Requests != 1 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	if _, err := e.store.CreateVersion(ctx, e.doc.ID, e.ver.ID, "edit", []byte("new html"), fixtureOwner); err != nil {
		t.Fatal(err)
	}
	stats, err := e.store.AdminStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Versions != 2 || stats.StorageBytes != int64(len("<html><body>fixture</body></html>")+len("new html")) {
		t.Fatalf("version sizes: %+v", stats)
	}
	if err := e.store.ForgetSession(ctx, "valid"); err != nil {
		t.Fatal(err)
	}
	stats, err = e.store.AdminStats(ctx)
	if err != nil || stats.LoggedInUsers != 0 {
		t.Fatalf("logout: %+v %v", stats, err)
	}
}
func TestAdminDisabledByDefault(t *testing.T) {
	e := newTestEnv(t)
	r := do(t, e.h, http.MethodGet, "/v1/admin/stats", "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
	if r.Code != 403 {
		t.Fatalf("status=%d", r.Code)
	}
}

func TestAdminObservesExistingSessionsAndLogout(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", SessionSecret: oauthTestSigningMaterial})
	token := (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).Sign(fixtureOwner.ID)
	headers := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner), "Cookie": "slashdocs_session=" + token}
	do(t, e.h, http.MethodGet, "/v1/me", "", headers)
	stats, err := e.store.AdminStats(context.Background())
	if err != nil || stats.LoggedInUsers != 1 {
		t.Fatalf("observed: %+v %v", stats, err)
	}
	do(t, e.h, http.MethodPost, "/v1/auth/logout", "", headers)
	stats, err = e.store.AdminStats(context.Background())
	if err != nil || stats.LoggedInUsers != 0 {
		t.Fatalf("logged out: %+v %v", stats, err)
	}
}
