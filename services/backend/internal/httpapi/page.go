package httpapi

import (
	"html"
	"net/http"
	"strings"
)

// pageTemplate is a tiny, self-contained HTML page for the browser-visible
// endpoints (email verification and the OAuth result). It carries no script and
// no external asset: it must render from a phone browser with no extra round
// trips. The three %s slots are the title (twice) and the message.
const pageTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s · CodeInOven</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  background: #101014; color: #f4f4f5; padding: 24px; }
main { max-width: 34rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
p { margin: 0; line-height: 1.6; color: #d4d4d8; }
</style>
</head>
<body>
<main>
<h1>%s</h1>
<p>%s</p>
</main>
</body>
</html>
`

// writePage renders one browser page.
func writePage(w http.ResponseWriter, status int, title, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)

	safeTitle := html.EscapeString(title)
	body := strings.Replace(pageTemplate, "%s", safeTitle, 1)
	body = strings.Replace(body, "%s", safeTitle, 1)
	body = strings.Replace(body, "%s", html.EscapeString(message), 1)
	_, _ = w.Write([]byte(body))
}
