package main

import (
	"flag"
	"os"
	"os/signal"
	"syscall"

	"github.com/zekurio/blitzcrank/pkg/config"
	"github.com/zekurio/blitzcrank/pkg/discord"
	"github.com/zekurio/blitzcrank/pkg/discord/commands/slashcommands"
	"github.com/zekurio/kommando"
	"github.com/zekurio/kommando/store"
)

var (
	fConfigPath = flag.String("c", "config.toml", "The location of the config file.")
)

func main() {
	flag.Parse()

	cfg, err := config.Parse(*fConfigPath, "BC_", config.DefaultConfig)
	if err != nil {
		panic("Failed parsing config.")
	}

	// init discord
	d, err := discord.New(cfg.Discord)
	if err != nil {
		panic("Failed initializing discord")
	}

	// init command handler
	kommando, err := kommando.New(d.Session(), kommando.Options{
		CommandStore: store.NewDefault(),
	})
	if err != nil {
		panic("Failed initializing command handler")
	}

	// register commands
	kommando.RegisterCommands(new(slashcommands.Ping))

	err = d.Open()
	if err != nil {
		panic("Failed opening connection to discord")
	}

	// set up signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// block until a signal is received
	sig := <-sigChan
	println("Received signal:", sig)

	// perform cleanup
	kommando.UnregisterCommands()
	d.Close()
}
