package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"blitzcrank/internal/automation"
	"blitzcrank/internal/config"
	"blitzcrank/internal/discord"
	"blitzcrank/internal/harness"
	"blitzcrank/internal/logging"
	"blitzcrank/internal/pi"
	"blitzcrank/internal/store"
	"blitzcrank/internal/tools"
	"blitzcrank/internal/webhook"
)

func main() {
	logging.SetupFromEnv()
	if err := runBot(); err != nil {
		log.Fatal(err)
	}
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
	finishStep(nil)

	finishStep = startup.start("create_harness_manager")
	manager := harness.NewManager(cfg, runner, registry, state)
	finishStep(nil)

	finishStep = startup.start("start_webhook_server")
	webhookServer := webhook.NewServer(cfg, manager)
	if err := webhookServer.Start(ctx); err != nil {
		finishStep(err)
		return fmt.Errorf("start webhook server: %w", err)
	}
	finishStep(nil)

	finishStep = startup.start("create_automation_scheduler")
	scheduler := automation.NewScheduler(cfg, runner, nil)
	scheduler.SetToolFailureStore(webhookServer)
	finishStep(nil)

	finishStep = startup.start("start_discord_automation_bot")
	discordBot, err := discord.New(cfg, scheduler)
	if err != nil {
		finishStep(err)
		return fmt.Errorf("create discord automation bot: %w", err)
	}
	if discordBot != nil {
		defer discordBot.Close()
		if err := discordBot.Start(); err != nil {
			finishStep(err)
			return fmt.Errorf("start discord automation bot: %w", err)
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

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := webhookServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("shutdown webhook server: %v", err)
	}
	return nil
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
		name = "Blitzcrank"
	}
	log.Printf("startup completed: bot=%q duration=%s", name, startupDuration(time.Since(l.startedAt)))
}

func startupDuration(duration time.Duration) time.Duration {
	return duration.Round(time.Millisecond)
}
