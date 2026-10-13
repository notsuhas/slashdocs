package postgres_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
)

func TestAdminConcurrentReplicaFlushes(t *testing.T) {
	first := newStore(t)
	second := pgrepo.New(first.Pool())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const principals, rounds = 300, 40
	for range rounds {
		for i := range principals {
			id := fmt.Sprintf("replica-user-%03d", i)
			for _, store := range []*pgrepo.Store{first, second} {
				if err := store.RecordActivity(ctx, id, true); err != nil {
					t.Fatal(err)
				}
			}
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		for _, store := range []*pgrepo.Store{first, second} {
			go func() { <-start; results <- store.FlushAdminActivity(ctx) }()
		}
		close(start)
		for range 2 {
			if err := <-results; err != nil {
				t.Fatalf("concurrent replica flush: %v", err)
			}
		}
	}
	var total int64
	if err := first.Pool().QueryRow(ctx, "SELECT sum(requests) FROM admin_activity").Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != 2*principals*rounds {
		t.Fatalf("requests = %d, want %d", total, 2*principals*rounds)
	}
}
