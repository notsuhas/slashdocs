package server

import (
	"context"
	"log/slog"
	"time"
)

// RunAdminObservations owns periodic flushes, retention, and the final shutdown flush.
func (s *Server) RunAdminObservations(ctx context.Context) {
	flush := time.NewTicker(5 * time.Second)
	cleanup := time.NewTicker(time.Hour)
	defer flush.Stop()
	defer cleanup.Stop()
	prune := func() {
		if err := s.adminRepository.PruneAdminObservations(ctx); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "admin retention failed", "error", err)
		}
	}
	prune()
	for {
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.adminRepository.FlushAdminActivity(shutdown); err != nil {
				slog.ErrorContext(shutdown, "admin shutdown flush failed", "error", err)
			}
			return
		case <-flush.C:
			if err := s.adminRepository.FlushAdminActivity(ctx); err != nil && ctx.Err() == nil {
				slog.ErrorContext(ctx, "admin activity flush failed", "error", err)
			}
		case <-cleanup.C:
			prune()
		}
	}
}
