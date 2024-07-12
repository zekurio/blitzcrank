package main

import (
	"flag"

	"github.com/zekurio/blitzcrank/pkg/commandhandler"
	"github.com/zekurio/blitzcrank/pkg/commandhandler/commands"
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
	cmdHandler := commandhandler.New(d.Session())
	cmdHandler.RegisterCommand(new(commands.Ping))

	err = d.Open()
	if err != nil {
		panic("Failed opening connection to discord")
	}
}
