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

	cfg, err := config.Load(".env")
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	registry := tools.NewRegistry(cfg)
	state, err := store.Open(ctx, cfg.DatabasePath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer state.Close()

	assistant, err := agent.New(cfg, registry)
	if err != nil {
		log.Fatalf("create agent: %v", err)
	}

	var bot *discord.Bot
	if cfg.DiscordToken != "" && cfg.AgentDiscordChannelID != "" {
		bot, err = discord.NewBot(cfg, assistant, state)
		if err != nil {
			log.Fatalf("create discord bot: %v", err)
		}
		if err := bot.Start(); err != nil {
			log.Fatalf("start discord bot: %v", err)
		}
		defer bot.Close()
	} else {
		log.Printf("discord listener disabled: DISCORD_TOKEN and DISCORD_CHANNEL_ID are both required to enable it")
	}

	manager := harness.NewManager(cfg, assistant, registry, state)
	webhookServer := webhook.NewServer(cfg, manager)
	if err := webhookServer.Start(ctx); err != nil {
		log.Fatalf("start webhook server: %v", err)
	}

	scheduler := automation.NewScheduler(cfg, assistant, bot, state)
	assistant.SetAutomationMetadataProvider(scheduler)
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
	scheduler.Start(ctx)

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
