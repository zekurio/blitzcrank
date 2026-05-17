package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
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
	if len(os.Args) >= 3 && os.Args[1] == "config" {
		runConfigCommand(os.Args[2], os.Args[3:])
		return
	}
	if len(os.Args) >= 3 && os.Args[1] == "codex" {
		runCodexCommand(os.Args[2])
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var restartRequested atomic.Bool

	startup := newStartupLogger()
	finishStep := startup.start("load_config")
	cfg, err := config.Load(".env")
	finishStep(err)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	finishStep = startup.start("create_tool_registry")
	registry := tools.NewRegistry(cfg)
	finishStep(nil)

	finishStep = startup.start("open_store")
	state, err := store.Open(ctx, cfg.DatabasePath)
	finishStep(err)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer state.Close()

	finishStep = startup.start("create_agent")
	assistant, err := agent.New(cfg, registry)
	finishStep(err)
	if err != nil {
		log.Fatalf("create agent: %v", err)
	}

	var bot *discord.Bot
	if cfg.DiscordToken != "" && cfg.AgentDiscordChannelID != "" {
		finishStep = startup.start("create_discord_bot")
		bot, err = discord.NewBot(cfg, assistant, state)
		finishStep(err)
		if err != nil {
			log.Fatalf("create discord bot: %v", err)
		}
		finishStep = startup.start("start_discord_bot")
		if err := bot.Start(); err != nil {
			finishStep(err)
			log.Fatalf("start discord bot: %v", err)
		}
		finishStep(nil)
		defer bot.Close()
	} else {
		log.Printf("discord listener disabled: DISCORD_TOKEN and DISCORD_CHANNEL_ID are both required to enable it")
	}

	finishStep = startup.start("create_harness_manager")
	manager := harness.NewManager(cfg, assistant, registry, state)
	finishStep(nil)

	finishStep = startup.start("start_webhook_server")
	webhookServer := webhook.NewServer(cfg, manager)
	if err := webhookServer.Start(ctx); err != nil {
		finishStep(err)
		log.Fatalf("start webhook server: %v", err)
	}
	finishStep(nil)

	finishStep = startup.start("create_automation_scheduler")
	scheduler := automation.NewScheduler(cfg, assistant, bot, state)
	assistant.SetAutomationMetadataProvider(scheduler)
	finishStep(nil)

	finishStep = startup.start("wire_runtime_control")
	runtime := &runtimeControl{
		cfg:         cfg,
		skills:      assistant,
		automations: scheduler,
		stop:        stop,
		restarting:  &restartRequested,
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
	if restartRequested.Load() {
		os.Exit(42)
	}
}

type runtimeControl struct {
	mu          sync.Mutex
	cfg         config.Config
	skills      interface{ ReloadSkills() error }
	automations interface {
		ReloadAutomations() error
		UpdateConfig(config.Config)
		RunAutomation(context.Context, string) error
		AutomationNames() []string
		AutomationStatus(time.Time) string
	}
	stop       context.CancelFunc
	restarting *atomic.Bool
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

func (r *runtimeControl) ReloadSkills() error {
	return r.skills.ReloadSkills()
}

func (r *runtimeControl) ReloadAutomations() error {
	return r.automations.ReloadAutomations()
}

func (r *runtimeControl) Restart() {
	if r.restarting != nil {
		r.restarting.Store(true)
	}
	if r.stop != nil {
		r.stop()
	}
}

func (r *runtimeControl) ConfigGet(key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return config.GetRuntimeConfigValue(r.cfg, key)
}

func (r *runtimeControl) ConfigSet(key, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := config.SetRuntimeConfigValue(r.cfg.RuntimeConfigPath, key, value); err != nil {
		return err
	}
	next := r.cfg
	if err := config.ApplyRuntimeConfigFile(&next); err != nil {
		return err
	}
	r.cfg = next
	if updater, ok := r.skills.(interface{ UpdateConfig(config.Config) }); ok {
		updater.UpdateConfig(next)
	}
	r.automations.UpdateConfig(next)
	return nil
}

func (r *runtimeControl) RunAutomation(ctx context.Context, name string) error {
	return r.automations.RunAutomation(ctx, name)
}

func (r *runtimeControl) AutomationNames() []string {
	return r.automations.AutomationNames()
}

func (r *runtimeControl) AutomationStatus(now time.Time) string {
	return r.automations.AutomationStatus(now)
}

func runConfigCommand(command string, args []string) {
	cfg, err := config.LoadRelaxed(".env")
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	switch command {
	case "get":
		if len(args) != 1 {
			log.Fatalf("usage: blitzcrank config get <key>")
		}
		value, err := config.GetRuntimeConfigValue(cfg, args[0])
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(value)
	case "set":
		if len(args) < 2 {
			log.Fatalf("usage: blitzcrank config set <key> <value>")
		}
		if err := config.SetRuntimeConfigValue(cfg.RuntimeConfigPath, args[0], strings.Join(args[1:], " ")); err != nil {
			log.Fatal(err)
		}
	case "keys":
		for _, key := range config.RuntimeConfigKeys() {
			fmt.Println(key)
		}
	default:
		log.Fatalf("unknown config command %q; expected get, set, or keys", command)
	}
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
