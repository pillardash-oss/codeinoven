package config

import (
	"os"
	"strings"
)

// envOr returns the environment value, or fallback when it is empty or unset.
func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// osEnv returns the trimmed environment value, or "" when unset.
func osEnv(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

// splitList splits a comma separated value, dropping empty entries.
func splitList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
