package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
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
	if err := e.store.ObserveSession(ctx, auth.VerifiedSession{TokenHash: "valid", UserID: fixtureOwner.ID, ExpiresAt: time.Now().Add(time.Hour).Unix(), SigningKeyID: (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID()}); err != nil {
		t.Fatal(err)
	}
	if err := e.store.ObserveSession(ctx, auth.VerifiedSession{TokenHash: "expired", UserID: fixtureViewer.ID, ExpiresAt: time.Now().Add(-time.Hour).Unix(), SigningKeyID: (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID()}); err != nil {
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
	stats, err := e.store.AdminStats(ctx, (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Versions != 2 || stats.StorageBytes != int64(len("<html><body>fixture</body></html>")+len("new html")) {
		t.Fatalf("version sizes: %+v", stats)
	}
	if err := e.store.ForgetSession(ctx, auth.VerifiedSession{TokenHash: "valid", UserID: fixtureOwner.ID, ExpiresAt: time.Now().Add(time.Hour).Unix(), SigningKeyID: (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID()}); err != nil {
		t.Fatal(err)
	}
	stats, err = e.store.AdminStats(ctx, (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID())
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
	e.h = server.New(server.Config{Environment: "test", SessionSecret: oauthTestSigningMaterial}, server.WithRepository(e.store), server.WithAuthenticator(auth.DBAuthenticator{Resolver: e.store, SessionSecret: oauthTestSigningMaterial})).Handler()
	headers := map[string]string{"Cookie": "slashdocs_session=" + token}
	do(t, e.h, http.MethodGet, "/v1/me", "", headers)
	stats, err := e.store.AdminStats(context.Background(), (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID())
	if err != nil || stats.LoggedInUsers != 1 {
		t.Fatalf("observed: %+v %v", stats, err)
	}
	do(t, e.h, http.MethodPost, "/v1/auth/logout", "", headers)
	stats, err = e.store.AdminStats(context.Background(), (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID())
	if err != nil || stats.LoggedInUsers != 0 {
		t.Fatalf("logged out: %+v %v", stats, err)
	}
}

func TestAdminCountsMCPDispatch(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	response := mcpPost(t, e, token, "", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "whoami", "arguments": map[string]any{}}})
	assertStatus(t, response, http.StatusOK)
	stats, err := e.store.AdminStats(context.Background(), (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).SigningKeyID())
	if err != nil || len(stats.Daily) != 1 || stats.Daily[0].Requests != 1 || stats.Active24h != 1 {
		t.Fatalf("MCP usage: %+v %v", stats, err)
	}
}
func TestAdminRetentionAndInitialization(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	stats, err := e.store.AdminStats(ctx, "")
	if err != nil || stats.TrackingSince == "" || len(stats.Daily) != 0 {
		t.Fatalf("initialization: %+v %v", stats, err)
	}
	if _, err := e.store.Pool().Exec(ctx, "INSERT INTO admin_activity VALUES('2000-01-01','old',true,5,'2000-01-01'); INSERT INTO admin_sessions(token_hash,user_id,expires_at,signing_key_id) VALUES('old','owner_1','2000-01-01','old-key')"); err != nil {
		t.Fatal(err)
	}
	if err := e.store.PruneAdminObservations(ctx); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := e.store.Pool().QueryRow(ctx, "SELECT (SELECT count(*) FROM admin_activity)+(SELECT count(*) FROM admin_sessions)").Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("retention: rows=%d err=%v", rows, err)
	}
	after, err := e.store.AdminStats(ctx, "")
	if err != nil || after.TrackingSince == "" || after.TrackingSince != stats.TrackingSince {
		t.Fatalf("tracking boundary changed: %+v %v", after, err)
	}
}
func TestAdminSessionKeyRotation(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	if err := e.store.ObserveSession(ctx, auth.VerifiedSession{TokenHash: "old", UserID: fixtureOwner.ID, ExpiresAt: time.Now().Add(time.Hour).Unix(), SigningKeyID: "old-key"}); err != nil {
		t.Fatal(err)
	}
	stats, err := e.store.AdminStats(ctx, "new-key")
	if err != nil || stats.LoggedInUsers != 0 {
		t.Fatalf("previous key counted: %+v %v", stats, err)
	}
}
func TestAdminObservationsFlushAtShutdown(t *testing.T) {
	e := newTestEnv(t)
	if err := e.store.RecordActivity(context.Background(), fixtureOwner.ID, true); err != nil {
		t.Fatal(err)
	}
	srv := server.New(server.Config{Environment: "test"}, server.WithRepository(e.store))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	srv.RunAdminObservations(ctx)
	var requests int64
	if err := e.store.Pool().QueryRow(context.Background(), "SELECT sum(requests) FROM admin_activity").Scan(&requests); err != nil || requests != 1 {
		t.Fatalf("shutdown flush=%d err=%v", requests, err)
	}
}
func TestAdminBufferDoesNotUseDatabaseOnRequest(t *testing.T) {
	e := newTestEnv(t)
	e.store.Pool().Close()
	response := do(t, e.h, http.MethodGet, "/v1/me", "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
	if response.Code != 200 {
		t.Fatalf("observation failed user request: %d", response.Code)
	}
}

type pausedCredentialsRepository struct {
	repo.Repository
	started chan struct{}
	release chan struct{}
}

func (r pausedCredentialsRepository) ListCLICredentials(ctx context.Context, userID string) ([]repo.CLICredential, error) {
	close(r.started)
	select {
	case <-r.release:
		return r.Repository.ListCLICredentials(ctx, userID)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func TestAdminInFlightObservationCannotRestoreLoggedOutSession(t *testing.T) {
	for _, alreadyObserved := range []bool{false, true} {
		t.Run(fmt.Sprint(alreadyObserved), func(t *testing.T) {
			e := newTestEnv(t)
			codec := auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}
			token := codec.Sign(fixtureOwner.ID)
			session, ok := codec.VerifySessionDetails(token)
			if !ok {
				t.Fatal("session did not verify")
			}
			if alreadyObserved {
				if err := e.store.ObserveSession(context.Background(), session); err != nil {
					t.Fatal(err)
				}
			}
			replica := pgrepo.New(e.store.Pool())
			paused := pausedCredentialsRepository{Repository: replica, started: make(chan struct{}), release: make(chan struct{})}
			defer func() {
				select {
				case <-paused.release:
				default:
					close(paused.release)
				}
			}()
			handler := server.New(server.Config{Environment: "test", SessionSecret: oauthTestSigningMaterial}, server.WithRepository(paused), server.WithAuthenticator(auth.DBAuthenticator{Resolver: replica, SessionSecret: oauthTestSigningMaterial})).Handler()
			headers := map[string]string{"Cookie": "slashdocs_session=" + token}
			completed := make(chan int, 1)
			go func() {
				response := do(t, handler, http.MethodGet, "/v1/auth/cli/credentials", "", headers)
				completed <- response.Code
			}()
			select {
			case <-paused.started:
			case <-time.After(5 * time.Second):
				t.Fatal("request did not enter handler")
			}
			logout := do(t, handler, http.MethodPost, "/v1/auth/logout", "", headers)
			if logout.Code != 204 {
				t.Fatalf("logout=%d", logout.Code)
			}
			close(paused.release)
			select {
			case status := <-completed:
				if status != 200 {
					t.Fatalf("in-flight request=%d", status)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("in-flight request did not finish")
			}
			stats, err := e.store.AdminStats(context.Background(), codec.SigningKeyID())
			if err != nil || stats.LoggedInUsers != 0 || stats.Sessions != 0 {
				t.Fatalf("logout was undone: %+v %v", stats, err)
			}
		})
	}
}

func TestAdminCountsIDsResemblingExcludedRoutes(t *testing.T) {
	e := newTestEnv(t)
	headers := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)}
	r := do(t, e.h, http.MethodGet, "/v1/documents/presence", "", headers)
	assertStatus(t, r, http.StatusNotFound)
	r = do(t, e.h, http.MethodPut, "/v1/pins/kv/events", "", headers)
	assertStatus(t, r, http.StatusForbidden)
	stats, err := e.store.AdminStats(context.Background(), "")
	if err != nil || len(stats.Daily) != 1 || stats.Daily[0].Requests != 2 {
		t.Fatalf("resource-not-found counts: %+v %v", stats, err)
	}
}

func TestAdminExcludesPresenceAndEventStreams(t *testing.T) {
	e := newTestEnv(t)
	headers := map[string]string{"X-Test-Principal": principalHeader(fixtureOwner), "Content-Type": "application/json"}
	r := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/presence", `{"session":"admin-presence","version":"`+e.ver.ID+`"}`, headers)
	assertStatus(t, r, http.StatusNoContent)
	r = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/kv/events?session=bad!", "", headers)
	assertStatus(t, r, http.StatusBadRequest)
	stats, err := e.store.AdminStats(context.Background(), "")
	if err != nil || len(stats.Daily) != 0 {
		t.Fatalf("excluded operations counted: %+v %v", stats, err)
	}
}
