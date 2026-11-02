// Command seed writes a demo account and the content the mobile app shows on
// first run.
//
// It is safe to re-run: the account is upserted (password and verification are
// rebuilt from SEED_PASSWORD) and that user's content tables are truncated and
// rewritten inside one transaction.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/auth"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/config"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/logging"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// demoAccount is the account the mobile app signs in with on first run.
const (
	demoEmail   = "demo@codeinoven.local"
	demoName    = "Demo"
	defaultSeed = "oven-mobile-demo-pass"
)

func main() {
	if err := run(); err != nil {
		slog.Error("seed failed", "error", err.Error())
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger := logging.New(cfg.Environment)

	password := os.Getenv("SEED_PASSWORD")
	if password == "" {
		password = defaultSeed
	}
	if err := auth.ValidatePassword(password); err != nil {
		return fmt.Errorf("SEED_PASSWORD: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	database, err := store.Open(ctx, cfg.DatabaseURL, logger)
	if err != nil {
		return err
	}
	defer database.Close()

	if err := database.MigrateControl(ctx); err != nil {
		return err
	}

	user, err := ensureDemoUser(ctx, database, password)
	if err != nil {
		return err
	}

	rec, err := database.EnsureStore(ctx, auth.NewID(auth.PrefixStore), user.ID)
	if err != nil {
		return err
	}

	now := time.Now().UTC().Truncate(time.Second)
	projects := buildProjects(now)
	threads := buildThreads(projects, now)
	writeThreadRollups(threads)

	rows := 0
	err = database.ReplaceContent(ctx, rec.SchemaName, func(tx pgx.Tx) error {
		for _, project := range projects {
			source := project.source
			if source == "" {
				source = "local"
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO projects (
					id, name, path, source, host, oven_id, provider_id, workflow_id,
					icon, color, icon_type, custom_svg, pinned, hidden, sort_order,
					created_at, updated_at
				) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,NULL,$11,false,$12,$13,$14)`,
				project.id, project.name, project.path, source, project.host,
				project.providerID, project.workflowID, project.icon, project.color,
				project.iconType, project.pinned, project.sortOrder,
				project.createdAt, project.updatedAt,
			); err != nil {
				return fmt.Errorf("insert project %s: %w", project.name, err)
			}
			rows++
		}

		for _, thread := range threads {
			if _, err := tx.Exec(ctx, `
				INSERT INTO threads (
					id, project_id, title, status, read, pinned, archived, drafting,
					last_error, last_message_preview, message_count, last_activity,
					created_at, updated_at
				) VALUES ($1,$2,$3,$4,$5,$6,false,false,$7,$8,$9,$10,$11,$10)`,
				thread.id, thread.projectID, thread.title, thread.status, thread.read,
				thread.pinned, thread.lastError, thread.preview, len(thread.messages),
				thread.activity, thread.createdAt,
			); err != nil {
				return fmt.Errorf("insert thread %s: %w", thread.title, err)
			}
			rows++

			for index, message := range thread.messages {
				if _, err := tx.Exec(ctx, `
					INSERT INTO messages (id, thread_id, role, body, seq, created_at)
					VALUES ($1,$2,$3,$4,$5,$6)`,
					auth.NewID(auth.PrefixMessage), thread.id, message.role, message.body,
					index+1, message.at,
				); err != nil {
					return fmt.Errorf("insert message %d of %s: %w", index+1, thread.id, err)
				}
				rows++
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	logger.Info("seed complete",
		"email", demoEmail,
		"password_source", "SEED_PASSWORD",
		"projects", len(projects),
		"threads", len(threads),
		"rows_written", rows,
	)
	return nil
}

// ensureDemoUser creates or refreshes the demo account: verified, with the seed
// password, so a re-run always leaves a working sign-in.
func ensureDemoUser(ctx context.Context, database *store.Store, password string) (store.User, error) {
	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		return store.User{}, err
	}

	user, err := database.UserByEmail(ctx, demoEmail)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return store.User{}, err
		}
		name := demoName
		user, err = database.CreateUser(ctx, auth.NewID(auth.PrefixUser), demoEmail, &name)
		if err != nil {
			return store.User{}, err
		}
	}

	if err := database.UpdatePasswordHash(ctx, user.ID, passwordHash); err != nil {
		return store.User{}, err
	}
	user, err = database.MarkEmailVerified(ctx, user.ID, time.Now().UTC())
	if err != nil {
		return store.User{}, err
	}
	return user, nil
}

// seedProject is one project row to write.
type seedProject struct {
	id         string
	name       string
	path       string
	source     string
	host       *string
	providerID string
	workflowID string
	icon       string
	color      string
	iconType   string
	pinned     bool
	sortOrder  int
	createdAt  time.Time
	updatedAt  time.Time
	threads    int
}

// seedMessage is one message row to write.
type seedMessage struct {
	role string
	body string
	at   time.Time
}

// seedThread is one thread row plus its messages.
type seedThread struct {
	id        string
	projectID string
	title     string
	status    string
	read      bool
	pinned    bool
	lastError *string
	preview   *string
	createdAt time.Time
	activity  time.Time
	messages  []seedMessage
}

// buildProjects returns the six projects the demo account owns.
func buildProjects(now time.Time) []seedProject {
	host := "build.rallip.dev"
	projects := []seedProject{
		{name: "codeinoven", path: "/Users/demo/Development/codeinoven", icon: "codeinoven.png",
			providerID: "anthropic", workflowID: "default", iconType: "image", color: "#f97316",
			pinned: true, sortOrder: 0, createdAt: now.AddDate(0, -7, 0), threads: 89},
		{name: "inside-edge-classroom", path: "/Users/demo/Development/inside-edge-classroom",
			icon: "graduation-cap", providerID: "openai", workflowID: "default", iconType: "lucide",
			color: "#38bdf8", sortOrder: 1, createdAt: now.AddDate(0, -5, -3), threads: 12},
		{name: "rallip", path: "/srv/rallip", source: "ssh", host: &host, icon: "server",
			providerID: "anthropic", workflowID: "remote", iconType: "lucide", color: "#a3e635",
			sortOrder: 2, createdAt: now.AddDate(0, -4, -8), threads: 9},
		{name: "milogs", path: "/Users/demo/Development/milogs", icon: "notebook",
			providerID: "anthropic", workflowID: "default", iconType: "lucide", color: "#c084fc",
			sortOrder: 3, createdAt: now.AddDate(0, -3, -1), threads: 7},
		{name: "printwyze", path: "/Users/demo/Development/printwyze", icon: "printer",
			providerID: "openai", workflowID: "default", iconType: "lucide", color: "#fbbf24",
			sortOrder: 4, createdAt: now.AddDate(0, -2, -5), threads: 5},
		{name: "shiloh", path: "/Users/demo/Development/shiloh", icon: "leaf",
			providerID: "anthropic", workflowID: "default", iconType: "lucide", color: "#34d399",
			sortOrder: 5, createdAt: now.AddDate(0, -1, -2), threads: 4},
	}

	for i := range projects {
		projects[i].id = auth.NewID(auth.PrefixProject)
		projects[i].updatedAt = projects[i].createdAt.Add(72 * time.Hour)
	}
	return projects
}

// threadVerbs and threadTopics combine into distinct demo thread titles.
var threadVerbs = []string{"Fix", "Review", "Implement", "Debug", "Audit", "Polish"}

var threadTopics = []string{
	"the checkout retry loop",
	"session refresh on wake",
	"the transcript scroll position",
	"theme token drift",
	"the prompt queue",
	"Oven presence detection",
	"the diff viewer",
	"worktree cleanup",
	"the keyboard shortcut map",
	"provider failover",
	"tooltip timing",
	"the onboarding flow",
	"message pagination",
	"the settings migration",
	"SSH reconnect handling",
	"the artifact viewer",
	"notification batching",
	"the search index",
	"the mobile handoff",
	"window state restore",
	"the markdown renderer",
	"agent memory size",
	"the usage meter",
	"project sorting",
	"the file watcher",
	"the copy button",
	"a missing empty state",
	"the thread status badge",
	"the store schema version",
	"voice capture retries",
	"the release checklist",
}

// statusCycle spreads all nine statuses across the demo threads.
var statusCycle = []string{
	"completed", "executing", "awaiting_approval", "spec", "planning",
	"created", "failed", "interrupted", "working-paused",
}

// buildThreads builds every demo thread with its messages.
func buildThreads(projects []seedProject, now time.Time) []seedThread {
	threads := make([]seedThread, 0, 130)

	for projectIndex, project := range projects {
		span := time.Duration(project.threads) * 5 * time.Hour
		for i := 0; i < project.threads; i++ {
			index := projectIndex*100 + i
			age := time.Duration(i) * (span / time.Duration(project.threads))
			created := now.Add(-age - 3*time.Hour)
			activity := created.Add(time.Duration(37*i%600) * time.Minute)
			if activity.After(now) {
				activity = now.Add(-time.Duration(i%90) * time.Minute)
			}

			thread := seedThread{
				id:        auth.NewID(auth.PrefixThread),
				projectID: project.id,
				title:     threadVerbs[index%len(threadVerbs)] + " " + threadTopics[(index/len(threadVerbs))%len(threadTopics)],
				status:    statusCycle[index%len(statusCycle)],
				read:      i%3 == 0,
				pinned:    i%11 == 5,
				createdAt: created,
				activity:  activity,
			}
			if thread.status == "failed" {
				message := "The Oven lost its connection before the run finished."
				thread.lastError = &message
			}
			threads = append(threads, thread)
		}
	}

	// Three threads carry a full conversation; the rest get a prompt and a reply.
	rich := []int{0, 1, 2}
	conversations := [][]seedMessage{
		checkoutRetryConversation(threads[rich[0]].createdAt),
		sessionRefreshConversation(threads[rich[1]].createdAt),
		presenceConversation(threads[rich[2]].createdAt),
	}
	for position, threadIndex := range rich {
		threads[threadIndex].messages = conversations[position]
	}

	for i := range threads {
		if len(threads[i].messages) > 0 {
			continue
		}
		thread := &threads[i]
		thread.messages = shortConversation(*thread)
	}

	return threads
}

// writeThreadRollups derives message_count and the preview from the messages.
func writeThreadRollups(threads []seedThread) {
	for i := range threads {
		thread := &threads[i]
		if len(thread.messages) == 0 {
			continue
		}
		last := thread.messages[len(thread.messages)-1]
		preview := truncate(last.body, 160)
		thread.preview = &preview
		if last.at.After(thread.activity) {
			thread.activity = last.at
		}
	}
}

// shortConversation is the two message exchange every plain demo thread holds.
func shortConversation(thread seedThread) []seedMessage {
	prompt := "Please take a look at " + thread.title + ". Start by reading the relevant code, " +
		"then tell me what you would change and why before you touch anything."
	reply := "I read the code path behind this. The behaviour comes from two places disagreeing " +
		"about when state is considered settled.\n\n" +
		"My plan is to make one of them the single source of truth, move the other to read from it, " +
		"and add a regression test that fails on the current code. I have not changed anything yet.\n\n" +
		"Say the word and I will start with the smaller of the two changes."
	if thread.status == "created" {
		return []seedMessage{{role: "user", body: prompt, at: thread.createdAt.Add(time.Minute)}}
	}
	return []seedMessage{
		{role: "user", body: prompt, at: thread.createdAt.Add(time.Minute)},
		{role: "assistant", body: reply, at: thread.createdAt.Add(3 * time.Minute)},
	}
}

// truncate shortens a body to at most n runes on a word boundary.
func truncate(body string, n int) string {
	runes := []rune(body)
	if len(runes) <= n {
		return string(runes)
	}
	cut := string(runes[:n])
	for i := len(cut) - 1; i > 0; i-- {
		if cut[i] == ' ' {
			return cut[:i] + "…"
		}
	}
	return cut + "…"
}
