package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/automation"
	"blitzcrank/internal/config"
	"blitzcrank/internal/discord"
	"blitzcrank/internal/harness"
	"blitzcrank/internal/llm"
	"blitzcrank/internal/store"
	"blitzcrank/internal/tools"
	"blitzcrank/internal/webhook"
)

func main() {
	if len(os.Args) >= 3 && os.Args[1] == "codex" {
		runCodexCommand(os.Args[2])
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
		log.Printf("discord listener disabled: DISCORD_TOKEN and AGENT_DISCORD_CHANNEL_ID are both required to enable it")
	}

	manager := harness.NewManager(cfg, assistant, registry, state)
	webhookServer := webhook.NewServer(cfg, manager)
	if err := webhookServer.Start(ctx); err != nil {
		log.Fatalf("start webhook server: %v", err)
	}

	scheduler := automation.NewScheduler(cfg, assistant, bot, state)
	assistant.SetAutomationMetadataProvider(scheduler)
	scheduler.Start(ctx)

	log.Printf("%s is running", cfg.BotPublicName)
	<-ctx.Done()

	if err := webhookServer.Shutdown(context.Background()); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("shutdown webhook server: %v", err)
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
		if err := llm.CodexLogin(ctx, cfg, os.Stdout); err != nil {
			log.Fatalf("codex login: %v", err)
		}
	case "logout":
		if err := llm.CodexLogout(cfg); err != nil {
			log.Fatalf("codex logout: %v", err)
		}
		log.Printf("removed Codex credentials for profile %q", cfg.CodexAuthProfile)
	case "status":
		if err := llm.CodexStatus(cfg, os.Stdout); err != nil {
			log.Fatalf("codex status: %v", err)
		}
	default:
		log.Fatalf("unknown codex command %q; expected login, logout, or status", command)
	}
}
