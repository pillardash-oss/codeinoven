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
	"github.com/pillardash-oss/codeinoven/services/backend/internal/models"
	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

// demoAccount is the account the mobile app signs in with on first run.
const (
	demoEmail   = "demo@codeinoven.local"
	demoName    = "Demo"
	defaultSeed = "oven-mobile-demo-pass"

	// demoContextWindow is the context the demo models offer, so the composer's
	// meter draws a real window instead of an empty bar.
	demoContextWindow = 128_000
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

	// The demo thread identities are catalog ids, so a rename in the catalog fails
	// the seed instead of writing threads that name a model nothing can run.
	for _, identity := range threadIdentities {
		if !models.Has(identity.model) {
			return fmt.Errorf("seed: thread identity %q is not in the model catalog", identity.model)
		}
	}

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
	// The demo store may predate this binary: bring every provisioned store up to
	// the template before writing columns the seed now needs, exactly as the server
	// does at startup.
	if err := database.MigrateAllStores(ctx); err != nil {
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
	stampTurnUsage(threads)

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
					model, harness, thinking, permission, account, oven_id, file_system,
					context_window, last_error, last_message_preview, message_count,
					last_activity, created_at, updated_at
				) VALUES ($1,$2,$3,$4,$5,$6,false,false,$7,$8,$9,$10,$11,NULL,$12,$13,$14,$15,$16,$17,$18,$17)`,
				thread.id, thread.projectID, thread.title, thread.status, thread.read,
				thread.pinned, thread.model, thread.harness, thread.thinking, thread.permission,
				thread.account, thread.fileSystem, thread.contextWindow, thread.lastError,
				thread.preview, len(thread.messages), thread.activity, thread.createdAt,
			); err != nil {
				return fmt.Errorf("insert thread %s: %w", thread.title, err)
			}
			rows++

			for index, message := range thread.messages {
				if _, err := tx.Exec(ctx, `
					INSERT INTO messages (
						id, thread_id, role, body, seq, created_at,
						input_tokens, output_tokens, duration_ms, cost_micros
					) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
					auth.NewID(auth.PrefixMessage), thread.id, message.role, message.body,
					index+1, message.at, message.inputTokens, message.outputTokens,
					message.durationMs, message.costMicros,
				); err != nil {
					return fmt.Errorf("insert message %d of %s: %w", index+1, thread.id, err)
				}
				rows++
			}
		}

		for order, assistant := range seedAssistants() {
			if _, err := tx.Exec(ctx, `
				INSERT INTO assistants (
					id, name, description, schedule_name, color, custom_svg,
					scheduled, paused, thread_count, last_run_at, sort_order,
					created_at, updated_at
				) VALUES ($1,$2,$3,NULLIF($4,''),$5,NULLIF($6,''),$7,$8,$9,$10,$11,$10,$10)`,
				auth.NewID("ast"), assistant.name, assistant.description,
				assistant.schedule, assistant.color, assistant.customSVG,
				assistant.scheduled, assistant.paused, assistant.threads,
				now.Add(-time.Duration(order+1)*22*time.Hour), order,
			); err != nil {
				return fmt.Errorf("insert assistant %s: %w", assistant.name, err)
			}
			rows++
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

// seedMessage is one message row to write. The token counts are only set on
// assistant turns: a user message consumed nothing, and NULL says that honestly.
type seedMessage struct {
	role         string
	body         string
	at           time.Time
	inputTokens  *int
	outputTokens *int
	durationMs   *int
	costMicros   *int
}

// seedThread is one thread row plus its messages.
type seedThread struct {
	id            string
	projectID     string
	title         string
	status        string
	read          bool
	pinned        bool
	model         string
	harness       string
	thinking      string
	permission    string
	account       string
	fileSystem    bool
	contextWindow int
	lastError     *string
	preview       *string
	createdAt     time.Time
	activity      time.Time
	messages      []seedMessage
}

// seedIdentity is the harness and model a demo thread runs on.
type seedIdentity struct {
	model   string
	harness string
}

// threadIdentities are the pairs a demo thread reports to the mobile composer.
// They are written as pairs, not as two independent cycles, so every thread
// shows a combination that actually exists while the list still reads varied.
//
// The model ids are the catalog's own, because the phone draws its vendor mark and
// its label from the id: a demo thread naming a model the catalog does not list
// would render as a thread the picker cannot describe.
var threadIdentities = []seedIdentity{
	{model: "openai/gpt-6.1-sol", harness: "codex"},
	{model: "anthropic/claude-opus-5.5", harness: "claude-code"},
	{model: "deepseek/deepseek-v4.1-flash", harness: "pi"},
	{model: "anthropic/claude-sonnet-5.5", harness: "opencode"},
	{model: "opencode/beam-free", harness: "opencode"},
	{model: "deepseek/deepseek-v4-pro", harness: "pi"},
}

// thinkingCycle and permissionCycle vary the composer's chips across the demo
// threads, so the picker and the header have something honest to show. The
// accounts are the logins the demo's messages run as.
var (
	thinkingCycle   = []string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	permissionCycle = []string{"auto_review", "auto_review", "full_access"}
	accountCycle    = []string{"demo@codeinoven.local", "ops@rallip.dev"}
)

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
				id:            auth.NewID(auth.PrefixThread),
				projectID:     project.id,
				title:         threadVerbs[index%len(threadVerbs)] + " " + threadTopics[(index/len(threadVerbs))%len(threadTopics)],
				status:        statusCycle[index%len(statusCycle)],
				read:          i%3 == 0,
				pinned:        i%11 == 5,
				model:         threadIdentities[index%len(threadIdentities)].model,
				harness:       threadIdentities[index%len(threadIdentities)].harness,
				thinking:      thinkingCycle[index%len(thinkingCycle)],
				permission:    permissionCycle[index%len(permissionCycle)],
				account:       accountCycle[index%len(accountCycle)],
				fileSystem:    index%4 == 0,
				contextWindow: demoContextWindow,
				createdAt:     created,
				activity:      activity,
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

// stampTurnUsage gives every assistant turn the token counts a run would report.
//
// The meter, the usage panel and the rate chip are all derived from these columns,
// so without them a freshly seeded account would show zeros everywhere and nobody
// could tell a broken meter from an empty one. The numbers are deterministic and
// grow with the thread, so a reader sees variety while a re-run writes the same
// rows.
func stampTurnUsage(threads []seedThread) {
	for threadIndex := range threads {
		assistantTurns := 0
		for messageIndex := range threads[threadIndex].messages {
			message := &threads[threadIndex].messages[messageIndex]
			if message.role != "assistant" {
				continue
			}

			assistantTurns++
			input := 1_200 + threadIndex*37 + assistantTurns*640
			output := 180 + threadIndex*11 + assistantTurns*220
			duration := 2_400 + assistantTurns*1_800
			// $3 per million input and $15 per million output, in micros.
			cost := input*3 + output*15

			message.inputTokens = &input
			message.outputTokens = &output
			message.durationMs = &duration
			message.costMicros = &cost
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
