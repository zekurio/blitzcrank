package runtimectx

import "strings"

const CharsPerToken = 4

type LayerBudget string

const (
	LayerBudgetProtected     LayerBudget = "protected"
	LayerBudgetCompress      LayerBudget = "compress"
	LayerBudgetSummarize     LayerBudget = "summarize"
	LayerBudgetManifestFirst LayerBudget = "manifest_first"
)

type Layer struct {
	Key     string
	Title   string
	Content string
	Budget  LayerBudget
}

type LayerTokenEstimate struct {
	Key    string
	Budget LayerBudget
	Tokens int
}

func EstimateTextTokens(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	return (len(text) + CharsPerToken - 1) / CharsPerToken
}

func EstimateLayerTokens(layers []Layer) []LayerTokenEstimate {
	out := make([]LayerTokenEstimate, 0, len(layers))
	for _, layer := range layers {
		out = append(out, LayerTokenEstimate{
			Key:    strings.TrimSpace(layer.Key),
			Budget: layer.Budget,
			Tokens: EstimateTextTokens(layer.Content),
		})
	}
	return out
}

func TotalLayerTokens(layers []Layer) int {
	total := 0
	for _, layer := range layers {
		total += EstimateTextTokens(layer.Content)
	}
	return total
}
