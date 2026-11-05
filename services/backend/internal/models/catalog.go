// Package models is the static catalog of models this service offers.
//
// The catalog is data, not a database table: nothing here changes per user, and a
// picker that has to answer on a cold phone start should not wait on a query. The
// ids are provider-prefixed (`openai/gpt-6.1-sol`, `anthropic/claude-opus-5.5`)
// because the client resolves its bundled vendor mark from the id alone, so the
// id has to state its provider as plainly as the label does.
//
// It is also the validation table: PATCH /v1/threads/{id} and a queued prompt only
// accept a model id that appears here, so a typo is a 400 instead of a thread
// that claims a model nothing can run.
package models

// Model is one model the picker offers.
type Model struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Provider      string `json:"provider"`
	ProviderLabel string `json:"providerLabel"`
	Favorite      bool   `json:"favorite"`
}

// Catalog is the payload of GET /v1/models: every model in picker order, plus the
// ids this account used most recently.
type Catalog struct {
	Items  []Model  `json:"items"`
	Recent []string `json:"recent"`
}

// Provider labels, in the order the picker groups them.
const (
	providerOpenCode  = "opencode"
	providerOpenAI    = "openai"
	providerAnthropic = "anthropic"
	providerDeepSeek  = "deepseek"
)

// providerLabels is the display name of each provider slug.
var providerLabels = map[string]string{
	providerOpenCode:  "OpenCode",
	providerOpenAI:    "OpenAI",
	providerAnthropic: "Anthropic",
	providerDeepSeek:  "DeepSeek",
}

// catalog is the ordered list the picker draws. Two models are favourites: the
// one this team reaches for on a long task, and the one it reaches for on a short
// one.
var catalog = []Model{
	{ID: providerOpenCode + "/beam-free", Name: "Beam Free", Provider: providerOpenCode},
	{ID: providerOpenCode + "/big-pickle", Name: "Big Pickle", Provider: providerOpenCode},
	{ID: providerOpenCode + "/claude-sonnet-5.5", Name: "Claude Sonnet 5.5", Provider: providerOpenCode},

	{ID: providerOpenAI + "/gpt-6.1-sol", Name: "GPT-6.1-Sol", Provider: providerOpenAI, Favorite: true},
	{ID: providerOpenAI + "/gpt-6-astra", Name: "GPT-6-Astra", Provider: providerOpenAI},
	{ID: providerOpenAI + "/gpt-5.6-sol", Name: "GPT-5.6-Sol", Provider: providerOpenAI},
	{ID: providerOpenAI + "/gpt-5.5", Name: "GPT-5.5", Provider: providerOpenAI},

	{ID: providerAnthropic + "/claude-opus-5.5", Name: "Claude Opus 5.5", Provider: providerAnthropic},
	{ID: providerAnthropic + "/claude-sonnet-5.5", Name: "Claude Sonnet 5.5", Provider: providerAnthropic},
	{ID: providerAnthropic + "/claude-haiku-4.5", Name: "Claude Haiku 4.5", Provider: providerAnthropic},
	{ID: providerAnthropic + "/opus-5-1m", Name: "Opus 5 with 1M context", Provider: providerAnthropic},

	{ID: providerDeepSeek + "/deepseek-v4.1-flash", Name: "DeepSeek V4.1 Flash", Provider: providerDeepSeek, Favorite: true},
	{ID: providerDeepSeek + "/deepseek-v4-pro", Name: "DeepSeek V4 Pro", Provider: providerDeepSeek},
}

// recentLimit is how many recently used ids the picker shows above the catalog.
const recentLimit = 5

// All returns a copy of the catalog with provider labels filled in, so a caller
// cannot mutate the package's own slice.
func All() []Model {
	out := make([]Model, len(catalog))
	for i, model := range catalog {
		model.ProviderLabel = labelFor(model.Provider)
		out[i] = model
	}
	return out
}

// labelFor returns the display label for a provider slug.
func labelFor(provider string) string {
	if label, ok := providerLabels[provider]; ok {
		return label
	}
	return provider
}

// Has reports whether id is a model this service offers.
func Has(id string) bool {
	for _, model := range catalog {
		if model.ID == id {
			return true
		}
	}
	return false
}

// Recent filters thread-used ids down to the ones the catalog contains, keeping
// the caller's order (most recent first) and capping the list.
//
// A thread may name a model the catalog has since dropped, and the picker cannot
// draw an unknown id, so those are skipped rather than shown as a blank chip.
func Recent(ids []string) []string {
	out := make([]string, 0, recentLimit)
	seen := make(map[string]bool, recentLimit)
	for _, id := range ids {
		if len(out) == recentLimit {
			break
		}
		if seen[id] || !Has(id) {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
