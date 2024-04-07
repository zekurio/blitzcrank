package config

import "github.com/zekurio/blitzcrank/pkg/discord"

var (
	DefaultConfig = Config{
		Discord: discord.Conf{
			Token:   "",
			OwnerID: "",
		},
	}
)

type Config struct {
	Discord discord.Conf
}
