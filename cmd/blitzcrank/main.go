package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"blitzcrank/internal/arrcalendar"
	"blitzcrank/internal/automation"
	"blitzcrank/internal/config"
	"blitzcrank/internal/digest"
	"blitzcrank/internal/discord"
	"blitzcrank/internal/harness"
	"blitzcrank/internal/logging"
	"blitzcrank/internal/pi"
	"blitzcrank/internal/review"
	"blitzcrank/internal/store"
	"blitzcrank/internal/tools"
	"blitzcrank/internal/webhook"
)

func main() {
	logging.SetupFromEnv()
	if len(os.Args) > 1 && os.Args[1] == "pi" {
		code, err := runPiPassthrough(os.Args[2:])
		if err != nil {
			log.Printf("pi command failed: %v", err)
		}
		os.Exit(code)
	}
	if err := runBot(); err != nil {
		log.Fatal(err)
	}
}

func runPiPassthrough(args []string) (int, error) {
	cfg, err := config.LoadRelaxed(".env")
	if err != nil {
		return 1, fmt.Errorf("load config: %w", err)
	}
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}

	cmd := exec.Command(cfg.PiCommand, args...)
	if cwd := strings.TrimSpace(cfg.PiCWD); cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = os.Environ()
	if agentDir := strings.TrimSpace(cfg.PiAgentDir); agentDir != "" {
		cmd.Env = append(cmd.Env, "PI_CODING_AGENT_DIR="+agentDir)
	}
	if sessionsDir := strings.TrimSpace(cfg.PiSessionsDir); sessionsDir != "" {
		cmd.Env = append(cmd.Env, "PI_CODING_AGENT_SESSION_DIR="+sessionsDir)
	}
	cmd.Env = appendPassthroughEnv(cmd.Env, "SEERR_BASE_URL", cfg.SeerrBaseURL)
	cmd.Env = appendPassthroughEnv(cmd.Env, "SEERR_API_KEY", cfg.SeerrAPIKey)
	cmd.Env = appendPassthroughEnv(cmd.Env, "SEERR_BOT_USER_ID", cfg.SeerrBotUserID)
	cmd.Env = appendPassthroughEnv(cmd.Env, "JELLYFIN_BASE_URL", cfg.JellyfinBaseURL)
	cmd.Env = appendPassthroughEnv(cmd.Env, "JELLYFIN_API_KEY", cfg.JellyfinAPIKey)
	cmd.Env = appendPassthroughEnv(cmd.Env, "SONARR_BASE_URL", cfg.SonarrBaseURL)
	cmd.Env = appendPassthroughEnv(cmd.Env, "SONARR_API_KEY", cfg.SonarrAPIKey)
	cmd.Env = appendPassthroughEnv(cmd.Env, "RADARR_BASE_URL", cfg.RadarrBaseURL)
	cmd.Env = appendPassthroughEnv(cmd.Env, "RADARR_API_KEY", cfg.RadarrAPIKey)
	cmd.Env = appendPassthroughEnv(cmd.Env, "SABNZBD_BASE_URL", cfg.SabnzbdBaseURL)
	cmd.Env = appendPassthroughEnv(cmd.Env, "SABNZBD_API_KEY", cfg.SabnzbdAPIKey)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), err
		}
		return 1, err
	}
	return 0, nil
}

func appendPassthroughEnv(env []string, key, value string) []string {
	if strings.TrimSpace(value) == "" {
		return env
	}
	return append(env, key+"="+strings.TrimSpace(value))
}

func runBot() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startup := newStartupLogger()
	finishStep := startup.start("load_config")
	cfg, err := config.Load(".env")
	finishStep(err)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	finishStep = startup.start("create_tool_registry")
	registry := tools.NewRegistry(cfg)
	finishStep(nil)

	finishStep = startup.start("open_store")
	state, err := store.Open(ctx, cfg.DatabasePath)
	finishStep(err)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer state.Close()

	finishStep = startup.start("create_pi_runner")
	runner := pi.NewRunner(cfg)
	if err := runner.PrepareSessionStorage(); err != nil {
		finishStep(err)
		return fmt.Errorf("prepare Pi session storage: %w", err)
	}
	finishStep(nil)

	finishStep = startup.start("start_mutation_review_broker")
	reviewBroker := review.NewBroker(runner, review.Options{
		ReviewTimeout:    cfg.ReviewTimeout,
		RunTokenTTL:      reviewRunTokenTTL(cfg),
		ConfirmationTTL:  cfg.ConfirmationTTL,
		ReviewerCapacity: cfg.ReviewCapacity,
		Audit:            state,
	})
	if err := reviewBroker.Start(ctx); err != nil {
		finishStep(err)
		return fmt.Errorf("start mutation review broker: %w", err)
	}
	defer reviewBroker.Close()
	runner.SetReviewBroker(reviewBroker)
	finishStep(nil)

	finishStep = startup.start("create_harness_manager")
	manager := harness.NewManager(cfg, runner, registry, state)
	manager.SetIssueResolutionReviewer(harness.NewBrokerIssueResolutionReviewer(reviewBroker, cfg.SeerrMutationBudget))
	finishStep(nil)

	finishStep = startup.start("start_webhook_server")
	webhookServer := webhook.NewServer(cfg, manager)
	if err := webhookServer.Start(ctx); err != nil {
		finishStep(err)
		return fmt.Errorf("start webhook server: %w", err)
	}
	finishStep(nil)

	finishStep = startup.start("start_issue_revisit_loop")
	manager.StartRevisitLoop(ctx)
	finishStep(nil)

	finishStep = startup.start("create_automation_scheduler")
	scheduler := automation.NewScheduler(cfg, runner, nil)
	scheduler.SetToolFailureStore(webhookServer)
	finishStep(nil)

	finishStep = startup.start("create_digest_services")
	digestService, err := createDigestService(ctx, cfg, state)
	finishStep(err)
	if err != nil {
		return fmt.Errorf("create digest services: %w", err)
	}

	finishStep = startup.start("start_discord_bot")
	discordOptions := discord.ConversationOptions{
		Context: ctx,
		Runner:  runner,
		Store:   state,
	}
	if digestService != nil {
		discordOptions.Digests = digestService
	}
	discordBot, err := discord.NewWithConversation(cfg, scheduler, discordOptions)
	if err != nil {
		finishStep(err)
		return fmt.Errorf("create Discord bot: %w", err)
	}
	if discordBot != nil {
		defer discordBot.Close()
		if digestService != nil {
			if err := scheduler.RegisterJob(automation.Job{
				Name:        "digest-dispatch",
				Description: "Deliver due personalized media digests by Discord DM.",
				Schedule:    cfg.DigestDispatchSchedule,
				Run: func(ctx context.Context) (string, error) {
					stats, err := digestService.DispatchDue(ctx, discordBot, 100)
					if err != nil {
						return "", fmt.Errorf("%s: %w", stats.String(), err)
					}
					return stats.String(), nil
				},
			}); err != nil {
				finishStep(err)
				return fmt.Errorf("register digest dispatch job: %w", err)
			}
		}
		if err := discordBot.Start(); err != nil {
			finishStep(err)
			return fmt.Errorf("start Discord bot: %w", err)
		}
		scheduler.SetReporter(discordBot.Reporter())
	}
	finishStep(nil)

	finishStep = startup.start("start_automation_scheduler")
	scheduler.Start(ctx)
	finishStep(nil)

	startup.done(cfg.BotPublicName)
	log.Printf("%s is running", cfg.BotPublicName)
	<-ctx.Done()
	scheduler.Wait()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := webhookServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("shutdown webhook server: %v", err)
	}
	return nil
}

func createDigestService(ctx context.Context, cfg config.Config, state *store.Store) (*digest.Service, error) {
	if !cfg.DigestsEnabled {
		return nil, nil
	}
	calendar, err := arrcalendar.New(cfg.SonarrBaseURL, cfg.SonarrAPIKey, cfg.RadarrBaseURL, cfg.RadarrAPIKey, nil)
	if err != nil {
		return nil, err
	}
	service, err := digest.NewService(state, cfg.Timezone)
	if err != nil {
		return nil, err
	}
	if err := service.ConfigureNewsletter(calendar, cfg.DigestMaxItems, cfg.DigestRetryDelay); err != nil {
		return nil, err
	}
	if err := service.RecoverDeliveries(ctx); err != nil {
		return nil, err
	}
	return service, nil
}

func reviewRunTokenTTL(cfg config.Config) time.Duration {
	ttl := cfg.RunTimeout
	if cfg.DiscordRunTimeout > ttl {
		ttl = cfg.DiscordRunTimeout
	}
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return ttl + time.Minute
}

type startupLogger struct {
	startedAt time.Time
}

func newStartupLogger() *startupLogger {
	now := time.Now()
	log.Printf("startup started")
	return &startupLogger{startedAt: now}
}

func (l *startupLogger) start(name string) func(error) {
	startedAt := time.Now()
	log.Printf("startup step started: name=%s", name)
	return func(err error) {
		status := "ok"
		if err != nil {
			status = "failed"
		}
		log.Printf("startup step completed: name=%s status=%s duration=%s", name, status, startupDuration(time.Since(startedAt)))
	}
}

func (l *startupLogger) done(publicName string) {
	name := strings.TrimSpace(publicName)
	if name == "" {
		name = "blitzcrank"
	}
	log.Printf("startup completed: bot=%q duration=%s", name, startupDuration(time.Since(l.startedAt)))
}

func startupDuration(duration time.Duration) time.Duration {
	return duration.Round(time.Millisecond)
}
