package server

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func (h handlers) isAdmin(p *auth.Principal) bool {
	if p == nil || p.Type != auth.PrincipalUser || p.Email == "" {
		return false
	}
	for _, email := range h.deps.adminUsers {
		if strings.EqualFold(strings.TrimSpace(email), p.Email) {
			return true
		}
	}
	return false
}
func (h handlers) adminStats(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	if !h.isAdmin(current(c)) {
		forbidden(c, "admin access required")
		return
	}
	store, ok := h.deps.repository.(repo.AdminObserver)
	if !ok {
		c.JSON(http.StatusServiceUnavailable, errorResponse("unavailable", "admin statistics unavailable", nil))
		return
	}
	out, err := store.AdminStats(c.Request.Context())
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}
func logObservation(c *gin.Context, err error) {
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "admin observation failed", "error", err)
	}
}
func (h handlers) observeActivity(c *gin.Context) {
	if !strings.HasPrefix(c.Request.URL.Path, "/v1/admin/") {
		if store, ok := h.deps.repository.(repo.AdminObserver); ok {
			p := current(c)
			logObservation(c, store.RecordActivity(c.Request.Context(), p.ID, p.Type == auth.PrincipalUser))
			if auth.BearerFromHeader(c.GetHeader("Authorization")) == "" {
				if ck, err := c.Request.Cookie(sessionCookieName); err == nil {
					h.observeAdminSession(c, ck.Value)
				}
			}
		}
	}
	c.Next()
}
func (h handlers) observeAdminSession(c *gin.Context, token string) {
	store, ok := h.deps.repository.(repo.AdminObserver)
	if !ok {
		return
	}
	codec := auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}
	uid, ok := codec.VerifySession(token)
	if !ok {
		return
	}
	expiry, ok := codec.SessionExpiry(token)
	if !ok {
		return
	}
	logObservation(c, store.ObserveSession(c.Request.Context(), auth.HashToken(token), uid, expiry))
}
func (h handlers) forgetAdminSession(c *gin.Context) {
	if store, ok := h.deps.repository.(repo.AdminObserver); ok {
		if ck, err := c.Request.Cookie(sessionCookieName); err == nil {
			logObservation(c, store.ForgetSession(c.Request.Context(), auth.HashToken(ck.Value)))
		}
	}
}
