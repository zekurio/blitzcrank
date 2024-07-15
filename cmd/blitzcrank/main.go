package main

import (
	"flag"
	"os"
	"os/signal"
	"syscall"

	"github.com/zekurio/blitzcrank/pkg/commandhandler"
	"github.com/zekurio/blitzcrank/pkg/commandhandler/commands"
	"github.com/zekurio/blitzcrank/pkg/commandhandler/store"
	"github.com/zekurio/blitzcrank/pkg/config"
	"github.com/zekurio/blitzcrank/pkg/discord"
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
	cmdHandler, err := commandhandler.New(d.Session(), commandhandler.Options{
		CommandStore: store.NewDefault(),
	})
	if err != nil {
		panic("Failed initializing command handler")
	}

	cmdHandler.RegisterCommands(new(commands.Ping))

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
	cmdHandler.UnregisterCommands()
	d.Close()
}
