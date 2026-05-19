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

	"blitzcrank/internal/agent"
	"blitzcrank/internal/automation"
	"blitzcrank/internal/config"
	"blitzcrank/internal/discord"
	"blitzcrank/internal/harness"
	"blitzcrank/internal/llm/codex"
	"blitzcrank/internal/store"
	"blitzcrank/internal/tools"
	"blitzcrank/internal/webhook"
)

func main() {
	if len(os.Args) >= 3 && os.Args[1] == "codex" {
		runCodexCommand(os.Args[2])
		return
	}
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

	finishStep = startup.start("create_agent")
	assistant, err := agent.New(cfg, registry)
	finishStep(err)
	if err != nil {
		return fmt.Errorf("create agent: %w", err)
	}

	bot, err := startDiscordBot(cfg, assistant, state, startup)
	if err != nil {
		return err
	}
	if bot != nil {
		defer bot.Close()
	}

	finishStep = startup.start("create_harness_manager")
	manager := harness.NewManager(cfg, assistant, registry, state)
	finishStep(nil)

	finishStep = startup.start("start_webhook_server")
	webhookServer := webhook.NewServer(cfg, manager)
	if err := webhookServer.Start(ctx); err != nil {
		finishStep(err)
		return fmt.Errorf("start webhook server: %w", err)
	}
	finishStep(nil)

	finishStep = startup.start("create_automation_scheduler")
	scheduler := automation.NewScheduler(cfg, assistant, bot, state)
	assistant.SetAutomationMetadataProvider(scheduler)
	finishStep(nil)

	finishStep = startup.start("wire_runtime_control")
	runtime := &runtimeControl{
		automations: scheduler,
	}
	if bot != nil {
		bot.SetRuntimeManager(runtime)
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

func startDiscordBot(cfg config.Config, assistant *agent.Agent, state *store.Store, startup *startupLogger) (*discord.Bot, error) {
	if cfg.DiscordToken == "" || cfg.AgentDiscordChannelID == "" {
		log.Printf("discord listener disabled: DISCORD_TOKEN and DISCORD_CHANNEL_ID are both required to enable it")
		return nil, nil
	}
	finishStep := startup.start("create_discord_bot")
	bot, err := discord.NewBot(cfg, assistant, state)
	finishStep(err)
	if err != nil {
		return nil, fmt.Errorf("create discord bot: %w", err)
	}
	finishStep = startup.start("start_discord_bot")
	if err := bot.Start(); err != nil {
		finishStep(err)
		return nil, fmt.Errorf("start discord bot: %w", err)
	}
	finishStep(nil)
	return bot, nil
}

type runtimeControl struct {
	automations interface {
		RunAutomation(context.Context, string) error
		AutomationNames() []string
	}
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

func (r *runtimeControl) RunAutomation(ctx context.Context, name string) error {
	return r.automations.RunAutomation(ctx, name)
}

func (r *runtimeControl) AutomationNames() []string {
	return r.automations.AutomationNames()
}

func runCodexCommand(command string) {
	cfg, err := config.LoadRelaxed(".env")
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	switch command {
	case "login":
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if err := codex.Login(ctx, cfg, os.Stdout); err != nil {
			log.Fatalf("codex login: %v", err)
		}
	case "logout":
		if err := codex.Logout(cfg); err != nil {
			log.Fatalf("codex logout: %v", err)
		}
		log.Printf("removed Codex credentials for profile %q", cfg.CodexAuthProfile)
	case "status":
		if err := codex.Status(cfg, os.Stdout); err != nil {
			log.Fatalf("codex status: %v", err)
		}
	default:
		log.Fatalf("unknown codex command %q; expected login, logout, or status", command)
	}
}
