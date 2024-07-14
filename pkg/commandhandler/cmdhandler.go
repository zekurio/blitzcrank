package commandhandler

import (
	"github.com/bwmarrin/discordgo"
)

type CommandHandler struct {
	// cmds is a map of command names to their respective command
	cmds    map[string]Command
	idCache map[string]string

	// s is our discord session
	s *discordgo.Session
}

func New(s *discordgo.Session) *CommandHandler {
	h := &CommandHandler{
		cmds:    make(map[string]Command),
		idCache: make(map[string]string),
		s:       s,
	}

	s.AddHandler(h.onReady)
	s.AddHandler(h.onInteractionCreate)

	return h
}

func (c *CommandHandler) RegisterCommand(cmds ...Command) {
	for _, cmd := range cmds {
		// TODO add checks for duplicate command names
		// TODO add checks for valid command names
		c.cmds[cmd.Name()] = cmd
	}
}

func (c *CommandHandler) HandleInteractionCreate(i *discordgo.InteractionCreate) {
	cmd, ok := c.cmds[i.ApplicationCommandData().Name]
	if !ok {
		return
	}

	cmd.Exec(i.Interaction)
}

func (c *CommandHandler) onReady(s *discordgo.Session, e *discordgo.Ready) {
	var (
		cachedCommand *discordgo.ApplicationCommand
		err           error
		update        = []*discordgo.ApplicationCommand{}
	)

	for name, cmd := range c.cmds {
		guildId := "" // TODO handle guild scoped commands
		if _, ok := c.idCache[name]; ok {
			appCommand := toApplicationCommand(cmd)
			update = append(update, appCommand)
		} else {
			cachedCommand, err = s.ApplicationCommandCreate(e.User.ID, guildId, toApplicationCommand(cmd))
			if err != nil {
				// TODO error handling
			} else {
				c.idCache[name] = cachedCommand.ID
			}
		}
	}

	if len(update) > 0 {
		_, err = s.ApplicationCommandBulkOverwrite(e.User.ID, "", update)
		if err != nil {
			// TODO error handling
		}
	}

	// TODO handle command cache recovery by saving the command ids to a file
}

func (c *CommandHandler) onInteractionCreate(s *discordgo.Session, e *discordgo.InteractionCreate) {
	switch e.Type {
	case discordgo.InteractionApplicationCommand:
		c.onInteractionApplicationCommand(s, e)
	default:
		return
	}
}

func (c *CommandHandler) onInteractionApplicationCommand(s *discordgo.Session, e *discordgo.InteractionCreate) {
	cmd := c.cmds[e.ApplicationCommandData().Name]
	if cmd == nil {
		return
	}

	err := cmd.Exec(e.Interaction)
	if err != nil {
		// TODO handle error
	}
}
