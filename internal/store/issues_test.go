package store

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestListActiveIssueThreadIDs(t *testing.T) {
	tests := []struct {
		name    string
		threads []IssueThread
		want    []string
	}{
		{
			name: "returns only active threads ordered by issue id",
			threads: []IssueThread{
				{IssueID: "20", Status: "active"},
				{IssueID: "10", Status: "active"},
				{IssueID: "15", Status: "completed"},
			},
			want: []string{"10", "20"},
		},
		{
			name: "returns empty result when none are active",
			threads: []IssueThread{
				{IssueID: "10", Status: "completed"},
				{IssueID: "20", Status: "completed"},
			},
			want: nil,
		},
		{
			name:    "returns empty result when no threads exist",
			threads: nil,
			want:    nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			state, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
			if err != nil {
				t.Fatalf("Open() error = %v", err)
			}
			defer state.Close()

			now := time.Now().UTC()
			for _, thread := range tt.threads {
				thread.CreatedAt = now
				thread.UpdatedAt = now
				if err := state.UpsertIssueThread(ctx, thread); err != nil {
					t.Fatalf("UpsertIssueThread(%q) error = %v", thread.IssueID, err)
				}
			}

			got, err := state.ListActiveIssueThreadIDs(ctx)
			if err != nil {
				t.Fatalf("ListActiveIssueThreadIDs() error = %v", err)
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("ListActiveIssueThreadIDs() = %#v, want %#v", got, tt.want)
			}
		})
	}
}
