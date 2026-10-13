package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
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
	out, err := h.deps.repository.AdminStats(c.Request.Context(), (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SigningKeyID())
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}
func logObservation(c *gin.Context, err error) {
	if err != nil && !errors.Is(err, context.Canceled) {
		slog.ErrorContext(c.Request.Context(), "admin observation failed", "error", err)
	}
}
func countAdminOperation(path string, status int) bool {
	return status != http.StatusTooManyRequests && !strings.HasPrefix(path, "/v1/admin/") && !strings.HasSuffix(path, "/presence") && !strings.HasSuffix(path, "/kv/events")
}
func (h handlers) observeActivity(c *gin.Context) {
	c.Next()
	if !countAdminOperation(c.Request.URL.Path, c.Writer.Status()) {
		return
	}
	p := current(c)
	logObservation(c, h.deps.repository.RecordActivity(c.Request.Context(), p.ID, p.Type == auth.PrincipalUser))
	if p.Session != nil {
		logObservation(c, h.deps.repository.ObserveSession(c.Request.Context(), *p.Session))
	}
}
func (h handlers) observeAdminSession(c *gin.Context, token string) {
	session, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifySessionDetails(token)
	if ok {
		logObservation(c, h.deps.repository.ObserveSession(c.Request.Context(), session))
	}
}
func (h handlers) forgetAdminSession(c *gin.Context) {
	if ck, err := c.Request.Cookie(sessionCookieName); err == nil {
		session, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifySessionDetails(ck.Value)
		if ok {
			logObservation(c, h.deps.repository.ForgetSession(c.Request.Context(), session))
		}
	}
}
