package config

import (
	"os"

	"github.com/joho/godotenv"
	"github.com/traefik/paerser/env"
	"github.com/traefik/paerser/file"
	"github.com/zekurio/blitzcrank/pkg/util"
)

func Parse[T any](filePath string, envPrefix string, def ...T) (cfg T, err error) {
	cfg = util.Opt(def)

	if err = file.Decode(filePath, &cfg); err != nil && !os.IsNotExist(err) {
		return
	}

	godotenv.Load()
	if err = env.Decode(os.Environ(), envPrefix, &cfg); err != nil {
		return
	}

	return
}
