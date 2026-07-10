package recommendation

import (
	"context"
	"time"
)

// MediaType identifies the broad kind of media represented by a candidate.
type MediaType string

const (
	MediaTypeAnime MediaType = "anime"
	MediaTypeShow  MediaType = "show"
	MediaTypeMovie MediaType = "movie"
)

// ReleaseKind identifies the release event represented by a candidate. A
// digital or physical release is a home-release signal, not proof that the
// title is already available in a media library.
type ReleaseKind string

const (
	ReleaseKindAiring     ReleaseKind = "airing"
	ReleaseKindDigital    ReleaseKind = "digital"
	ReleaseKindPhysical   ReleaseKind = "physical"
	ReleaseKindTheatrical ReleaseKind = "theatrical"
)

// Window is a half-open UTC time range: Start is inclusive and End is
// exclusive. Catalog release dates without a time component are represented at
// midnight UTC and should be rendered as civil dates rather than timestamps.
type Window struct {
	Start time.Time
	End   time.Time
}

// Candidate is one recommendation-worthy release event. MediaKey identifies a
// title within a catalog identity namespace. EventKey additionally identifies
// its release kind, scope, and date and must be deterministic across runs.
type Candidate struct {
	MediaKey    string
	EventKey    string
	MediaType   MediaType
	ReleaseKind ReleaseKind
	Title       string
	Overview    string
	URL         string
	Poster      string
	ReleaseAt   time.Time
	Genres      []string
	Popularity  float64
	Source      string
}

// Query describes one recommendation request. Empty media or release filters
// mean all supported values. Interests are case-insensitive genre weights;
// positive values promote matching candidates and negative values demote them.
type Query struct {
	SubjectID    string
	MediaTypes   []MediaType
	ReleaseKinds []ReleaseKind
	Region       string
	Locale       string
	Window       Window
	Interests    map[string]float64
	MaxItems     int
}

// Warning describes a recoverable partial failure. An engine can still return
// recommendations when one catalog or the optional profile source is down.
type Warning struct {
	Source  string
	Message string
}

type Result struct {
	Items    []Candidate
	Warnings []Warning
}

// Catalog provides release candidates from one upstream source. Implementations
// may return both candidates and an error when a later page failed; the engine
// keeps those candidates and surfaces the error as a partial warning.
type Catalog interface {
	Name() string
	Discover(context.Context, Query) ([]Candidate, error)
}

// Profile contains only recommendation inputs. A Jellyfin-backed implementation
// can derive canonical seen keys from ProviderIds without coupling the engine to
// Jellyfin DTOs or credentials.
type Profile struct {
	SeenMediaKeys []string
	GenreWeights  map[string]float64
}

type ProfileSource interface {
	Profile(context.Context, string) (Profile, error)
}

// RankInput is immutable context shared across scores for one engine run.
type RankInput struct {
	Query        Query
	Profile      Profile
	GenreWeights map[string]float64
}

// Ranker scores candidates within their media-type/release-kind group. Fair
// selection across groups is performed by Engine after ranking.
type Ranker interface {
	Score(Candidate, RankInput) float64
}
