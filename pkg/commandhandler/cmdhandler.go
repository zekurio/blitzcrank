package commandhandler

import (
	"errors"
	"regexp"
	"sync"

	"github.com/bwmarrin/discordgo"
	"github.com/zekurio/blitzcrank/pkg/commandhandler/store"
)

type CommandHandler struct {
	s *discordgo.Session

	cmds     map[string]Command
	idCache  map[string]string
	lockCmds sync.RWMutex

	options *Options
}

type Options struct {
	CommandStore store.CommandStore
}

var defaultOptions = Options{
	CommandStore: store.NewDefault(),
}

func New(s *discordgo.Session, options ...Options) (h *CommandHandler, err error) {
	h = &CommandHandler{
		cmds:    make(map[string]Command),
		idCache: make(map[string]string),
		s:       s,
	}

	h.options = &defaultOptions

	if len(options) > 0 {
		o := options[0]

		if o.CommandStore != nil {
			h.options.CommandStore = o.CommandStore
		}
	}

	if h.options.CommandStore != nil {
		h.idCache, err = h.options.CommandStore.Load()
		if err != nil {
			return
		}
	}

	s.AddHandler(h.onReady)
	s.AddHandler(h.onInteractionCreate)

	return
}

func (c *CommandHandler) RegisterCommands(cmds ...Command) (err error) {
	c.lockCmds.Lock()
	defer c.lockCmds.Unlock()

	regex, _ := regexp.Compile(`^[\-_0-9\p{L}\p{Devanagari}\p{Thai}]{1,32}$`)

	for _, cmd := range cmds {
		if cmd.Name() == "" {
			err = errors.New("command name cannot be empty")
			return
		}

		res := regex.MatchString(cmd.Name())

		if err != nil || !res {
			return errors.New("command name doesn't parse regex")
		}

		c.cmds[cmd.Name()] = cmd
	}

	return
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
