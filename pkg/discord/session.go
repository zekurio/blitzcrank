package discord

import (
	"log"

	"github.com/bwmarrin/discordgo"
)

type Discord struct {
	session *discordgo.Session
}

// New returns a new Discord instance, connecting must be handled outside new.
func New(cfg Conf) (*Discord, error) {
	var (
		t   Discord
		err error
	)

	t.session, err = discordgo.New("Bot " + cfg.Token)

	return &t, err
}

// Session returns our discordgo session
func (t *Discord) Session() *discordgo.Session {
	return t.session
}

// Open is used to open the discord connection and login
func (t *Discord) Open() error {
	cReady := make(chan struct{})

	t.session.AddHandlerOnce(func(s *discordgo.Session, e *discordgo.Ready) {
		botUser := e.User
		log.Printf("Logged in as: %s (%s)", botUser.Username, botUser.ID)
	})

	err := t.session.Open()
	if err != nil {
		return err
	}

	<-cReady

	return nil
}
