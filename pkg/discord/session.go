package discord

import (
	"github.com/bwmarrin/discordgo"
)

type DiscordConf struct {
	Token   string
	OwnerID string
}

type Discord struct {
	session *discordgo.Session
}

// New returns a new Discord instance, connecting must be handled outside of new.
func New(cfg DiscordConf) (*Discord, error) {
	var (
		t   Discord
		err error
	)

	t.session, err = discordgo.New("Bot " + cfg.Token)

	return &t, err
}

func (t *Discord) Session() *discordgo.Session {
	return t.session
}

func (t *Discord) Open() error {
	cReady := make(chan struct{})

	t.session.AddHandlerOnce(func(s *discordgo.Session, e *discordgo.Ready) {
		cReady <- struct{}{}
	})

	err := t.session.Open()
	if err != nil {
		return err
	}

	<-cReady

	return nil
}
