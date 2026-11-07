package httpapi

import (
	"net/http"
	"strconv"
	"strings"
)

// defaultLimit and maxLimit are the pagination bounds from the contract.
const (
	defaultLimit = 50
	maxLimit     = 200
)

// queryLimit reads ?limit=, defaulting to 50 and capping at 200.
func queryLimit(r *http.Request) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return defaultLimit, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, badRequest("limit must be a whole number")
	}
	if value < 1 {
		return 0, badRequest("limit must be at least 1")
	}
	if value > maxLimit {
		return maxLimit, nil
	}
	return value, nil
}

// queryBool reads a boolean query value, treating "1" and "true" as true.
func queryBool(r *http.Request, key string) (bool, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	switch strings.ToLower(raw) {
	case "", "0", "false":
		return false, nil
	case "1", "true":
		return true, nil
	default:
		return false, badRequest(key + " must be true or false")
	}
}
