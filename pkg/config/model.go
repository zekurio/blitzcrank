package config

import "github.com/zekurio/blitzcrank/pkg/discord"

var (
	DefaultConfig = Config{
		Discord: discord.DiscordConf{
			Token:   "",
			OwnerID: "",
		},
	}
)

type Config struct {
	Discord discord.DiscordConf
}
