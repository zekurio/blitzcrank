package models

import "testing"

func TestNewCatalogFromModelsDevJSON(t *testing.T) {
	catalog, err := NewCatalogFromModelsDevJSON([]byte(`{
		"openai": {
			"id": "openai",
			"models": {
				"gpt-test": {
					"id": "gpt-test",
					"name": "GPT Test",
					"family": "gpt",
					"reasoning": true,
					"tool_call": true,
					"structured_output": true,
					"limit": {"context": 123, "input": 100, "output": 23},
					"experimental": {"modes": {"fast": {"provider": {"body": {"service_tier": "priority"}}}}}
				}
			}
		}
	}`))
	if err != nil {
		t.Fatalf("NewCatalogFromModelsDevJSON() error = %v", err)
	}
	info, ok := catalog.Lookup("codex-oauth", "gpt-test")
	if !ok {
		t.Fatal("Lookup() did not find model")
	}
	if info.Provider != "openai" || info.ID != "gpt-test" || info.Limits.Context != 123 || info.Limits.Input != 100 || info.Limits.Output != 23 {
		t.Fatalf("model info = %#v", info)
	}
	if !info.Reasoning || !info.ToolCall || !info.StructuredOutput || !info.SupportsFastMode || !info.SupportsParallelTools {
		t.Fatalf("model capabilities = %#v", info)
	}
}

func TestModelsDevSnapshotUsesCatalogLimits(t *testing.T) {
	catalog, err := LoadModelsDevFile("models.dev.json")
	if err != nil {
		t.Fatalf("LoadModelsDevFile() error = %v", err)
	}
	if info, ok := catalog.models["openai/gpt-5.5"]; !ok || info.Limits.Context != 1050000 || info.Limits.Input != 922000 || info.Limits.Output != 128000 {
		t.Fatalf("openai/gpt-5.5 catalog entry = %#v, ok=%t", info, ok)
	}
	info, ok := catalog.Lookup("codex-oauth", "gpt-5.5")
	if !ok {
		t.Fatal("models.dev snapshot missing gpt-5.5")
	}
	if info.Limits.Context != 1050000 || info.Limits.Input != 922000 || info.Limits.Output != 128000 {
		t.Fatalf("gpt-5.5 limits = %#v", info.Limits)
	}
	info, ok = catalog.Lookup("openai", "gpt-5.2")
	if !ok {
		t.Fatal("models.dev snapshot missing gpt-5.2")
	}
	if direct, ok := catalog.models["openai/gpt-5.2"]; !ok || direct.Limits.Input != 272000 {
		t.Fatalf("openai/gpt-5.2 catalog entry = %#v, ok=%t", direct, ok)
	}
	if info.Limits.Context != 400000 || info.Limits.Input != 272000 || info.Limits.Output != 128000 {
		t.Fatalf("gpt-5.2 limits = %#v", info.Limits)
	}
}

func TestLookupEffectiveAppliesCodexOAuthLimits(t *testing.T) {
	source := Source{Path: "models.dev.json"}
	apiInfo, ok := LookupEffective(source, "openai", "gpt-5.5")
	if !ok {
		t.Fatal("models.dev snapshot missing openai/gpt-5.5")
	}
	if apiInfo.Limits.Context != 1050000 || apiInfo.Limits.Input != 922000 || apiInfo.Limits.Output != 128000 {
		t.Fatalf("openai gpt-5.5 limits = %#v", apiInfo.Limits)
	}

	codexInfo, ok := LookupEffective(source, "codex-oauth", "gpt-5.5")
	if !ok {
		t.Fatal("models.dev snapshot missing codex-oauth/gpt-5.5")
	}
	if codexInfo.Limits.Context != 400000 || codexInfo.Limits.Input != 272000 || codexInfo.Limits.Output != 128000 {
		t.Fatalf("codex-oauth gpt-5.5 limits = %#v", codexInfo.Limits)
	}
}
