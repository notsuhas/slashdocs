package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
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
func (h handlers) requireAdmin(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	if !h.isAdmin(current(c)) {
		forbidden(c, "admin access required")
		c.Abort()
		return
	}
}
func (h handlers) adminStats(c *gin.Context) {
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
	return status != http.StatusTooManyRequests && !strings.HasPrefix(path, "/v1/admin/") && path != "/v1/documents/:id/cursor" && path != "/v1/documents/:id/presence" && path != "/v1/documents/:id/kv/events"
}
func (h handlers) observeActivity(c *gin.Context) {
	c.Next()
	if !countAdminOperation(c.FullPath(), c.Writer.Status()) {
		return
	}
	p := current(c)
	logObservation(c, h.deps.repository.RecordActivity(c.Request.Context(), p.ID, p.Type == auth.PrincipalUser))
	if p.Session != nil {
		logObservation(c, h.deps.repository.ObserveSession(c.Request.Context(), *p.Session))
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

func (h handlers) adminPage(c *gin.Context) (int, bool) {
	page := 1
	if raw := c.Query("page"); raw != "" {
		var err error
		page, err = strconv.Atoi(raw)
		if err != nil || page < 1 || page > 10000 {
			badRequest(c, "invalid page")
			return 0, false
		}
	}
	if len(c.Query("q")) > 200 {
		badRequest(c, "search is too long")
		return 0, false
	}
	return page, true
}
func (h handlers) adminUsers(c *gin.Context) {
	page, ok := h.adminPage(c)
	if !ok {
		return
	}
	status := c.DefaultQuery("status", "all")
	if status != "all" && status != "logged_in" && status != "active" {
		badRequest(c, "invalid status")
		return
	}
	out, err := h.deps.repository.AdminUsers(c.Request.Context(), (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SigningKeyID(), c.Query("q"), status, page)
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}
func (h handlers) adminUserDocuments(c *gin.Context) {
	page, ok := h.adminPage(c)
	if !ok {
		return
	}
	kind := c.DefaultQuery("kind", "uploaded")
	if kind != "uploaded" && kind != "owned" {
		badRequest(c, "invalid document filter")
		return
	}
	out, err := h.deps.repository.AdminUserDocuments(c.Request.Context(), c.Param("id"), kind, c.Query("q"), page)
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}
