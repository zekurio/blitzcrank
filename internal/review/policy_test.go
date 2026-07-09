package review

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestClassifyDeterministicMutationPolicy(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		proposal Proposal
		wantRisk Risk
		wantCap  string
		wantErr  error
	}{
		{
			name:     "sonarr targeted refresh is low",
			proposal: mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "RefreshSeries", "seriesId": 42}),
			wantRisk: RiskLow,
			wantCap:  "sonarr.metadata_refresh",
		},
		{
			name:     "radarr search is medium",
			proposal: mutationProposal("radarr", "POST", "/api/v3/command", map[string]any{"name": "MoviesSearch", "movieIds": []int{42}}),
			wantRisk: RiskMedium,
			wantCap:  "radarr.search",
		},
		{
			name:     "manual import is medium",
			proposal: mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "ManualImport", "files": []any{map[string]any{"path": "/media/file.mkv"}}}),
			wantRisk: RiskMedium,
			wantCap:  "sonarr.manual_import",
		},
		{
			name:     "exact rejection cleanup is high",
			proposal: mutationProposal("radarr", "DELETE", "/api/v3/queue/7?blocklist=true&removeFromClient=true", nil),
			wantRisk: RiskHigh,
			wantCap:  "radarr.queue_rejection_cleanup",
		},
		{
			name:     "queue removal without rejection shape remains high",
			proposal: mutationProposal("sonarr", "DELETE", "/api/v3/queue/7", nil),
			wantRisk: RiskHigh,
			wantCap:  "sonarr.queue_cleanup",
		},
		{
			name:     "blocklist deletion is high",
			proposal: mutationProposal("sonarr", "DELETE", "/api/v3/blocklist/9", nil),
			wantRisk: RiskHigh,
			wantCap:  "sonarr.blocklist_delete",
		},
		{
			name:     "jellyfin refresh is low",
			proposal: mutationProposal("jellyfin", "POST", "/Items/abc/Refresh?Recursive=true&MetadataRefreshMode=Default", nil),
			wantRisk: RiskLow,
			wantCap:  "jellyfin.metadata_refresh",
		},
		{
			name:     "seerr request is medium",
			proposal: mutationProposal("seerr", "POST", "/api/v1/request", map[string]any{"mediaId": 42, "mediaType": "movie"}),
			wantRisk: RiskMedium,
			wantCap:  "seerr.media_request",
		},
		{
			name:     "harness seerr resolution is medium",
			proposal: mutationProposal("seerr", "POST", "/api/v1/issue/42/resolved", nil),
			wantRisk: RiskMedium,
			wantCap:  "seerr.issue_resolve",
		},
		{
			name:     "GET is not reviewed",
			proposal: Proposal{Service: "sonarr", Method: "GET", Path: "/api/v3/queue"},
			wantErr:  ErrNotMutation,
		},
		{
			name:     "arbitrary endpoint is forbidden",
			proposal: mutationProposal("sonarr", "DELETE", "/api/v3/series/42", nil),
			wantErr:  ErrForbidden,
		},
		{
			name:     "arbitrary command is forbidden",
			proposal: mutationProposal("radarr", "POST", "/api/v3/command", map[string]any{"name": "DeleteMovie"}),
			wantErr:  ErrForbidden,
		},
		{
			name:     "queue query is closed",
			proposal: mutationProposal("sonarr", "DELETE", "/api/v3/queue/7?deleteFiles=true", nil),
			wantErr:  ErrForbidden,
		},
		{
			name:     "credentials in body are forbidden",
			proposal: mutationProposal("seerr", "POST", "/api/v1/request", map[string]any{"mediaId": 42, "api_key": "secret"}),
			wantErr:  ErrForbidden,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			classification, err := Classify(test.proposal)
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("Classify() error = %v, want errors.Is(%v)", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			if classification.Risk != test.wantRisk || classification.Capability != test.wantCap {
				t.Fatalf("Classify() = %+v, want risk=%s capability=%s", classification, test.wantRisk, test.wantCap)
			}
		})
	}
}

func TestBindingHashBindsExactProposalAndTrustedRunContext(t *testing.T) {
	t.Parallel()

	run := RunContext{
		RunID: "run-1", Source: "discord_private", ActorID: "user-1", ConversationID: "thread-1", Budget: 3,
	}
	left := mutationProposal("sonarr", "POST", "/api/v3/command", json.RawMessage(`{"name":"EpisodeSearch","episodeIds":[1]}`))
	right := mutationProposal("sonarr", "POST", "/api/v3/command", json.RawMessage(`{"episodeIds":[1],"name":"EpisodeSearch"}`))
	leftHash, err := BindingHash(run, left)
	if err != nil {
		t.Fatalf("BindingHash(left) error = %v", err)
	}
	rightHash, err := BindingHash(run, right)
	if err != nil {
		t.Fatalf("BindingHash(right) error = %v", err)
	}
	if leftHash != rightHash {
		t.Fatalf("canonical key order changed binding: %s != %s", leftHash, rightHash)
	}

	mutations := []struct {
		name     string
		run      RunContext
		proposal Proposal
	}{
		{name: "body", run: run, proposal: mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{2}})},
		{name: "path", run: run, proposal: mutationProposal("sonarr", "POST", "/api/v3/command/", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{1}})},
		{name: "run", run: withRunID(run, "run-2"), proposal: left},
		{name: "source", run: withSource(run, "seerr_issue_comment"), proposal: left},
		{name: "actor", run: withActor(run, "user-2"), proposal: left},
		{name: "conversation", run: withConversation(run, "thread-2"), proposal: left},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			hash, err := BindingHash(mutation.run, mutation.proposal)
			if err != nil {
				t.Fatalf("BindingHash() error = %v", err)
			}
			if hash == leftHash {
				t.Fatalf("BindingHash() did not change for %s", mutation.name)
			}
		})
	}
}

func TestParseReviewerResponseStrictSchema(t *testing.T) {
	t.Parallel()

	valid := `{"verdict":"approve","authority_basis":"explicit_intent","reason":"authorized"}`
	response, err := ParseReviewerResponse([]byte(valid))
	if err != nil {
		t.Fatalf("ParseReviewerResponse(valid) error = %v", err)
	}
	if response.Verdict != VerdictApprove || response.AuthorityBasis != AuthorityExplicitIntent {
		t.Fatalf("ParseReviewerResponse(valid) = %+v", response)
	}

	for _, invalid := range []string{
		`{"verdict":"allow","authority_basis":"explicit_intent","reason":"x"}`,
		`{"verdict":"approve","authority_basis":"explicit_intent","reason":""}`,
		`{"verdict":"approve","reason":"x"}`,
		`{"verdict":"approve","authority_basis":"explicit_intent","reason":"x","risk":"low"}`,
		"```json\n" + valid + "\n```",
	} {
		if _, err := ParseReviewerResponse([]byte(invalid)); err == nil {
			t.Fatalf("ParseReviewerResponse(%q) unexpectedly succeeded", invalid)
		}
	}
}

func mutationProposal(service, method, path string, body any) Proposal {
	return Proposal{
		Service: service, Method: method, Path: path, Body: body,
		Purpose:     "perform the exact requested action after a current read",
		SafetyClaim: "narrow_mutation: exact target was checked",
		Evidence:    []Evidence{{Service: service, Method: "GET", Path: "/current", Summary: `{"current":true}`}},
	}
}

func withRunID(run RunContext, value string) RunContext {
	run.RunID = value
	return run
}

func withSource(run RunContext, value string) RunContext {
	run.Source = value
	return run
}

func withActor(run RunContext, value string) RunContext {
	run.ActorID = value
	return run
}

func withConversation(run RunContext, value string) RunContext {
	run.ConversationID = value
	return run
}
