package commandhandler

import (
	"errors"
	"log"
	"regexp"
	"sync"

	"github.com/bwmarrin/discordgo"
	"github.com/zekurio/blitzcrank/pkg/commandhandler/state"
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
	State *discordgo.State

	CommandStore store.CommandStore

	OnSystemError  func(err error)
	OnCommandError func(err error)
}

var defaultOptions = Options{
	State: state.NewSessionWrapped(),

	CommandStore: store.NewDefault(),

	OnSystemError: func(err error) {
		log.Printf("command handler - error: %s", err)
	},

	OnCommandError: func(err error) {
		log.Printf("command handler - command error: %s", err)
	},
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

		if o.State != nil {
			h.options.State = o.State
		}

		if o.OnSystemError != nil {
			h.options.OnSystemError = o.OnSystemError
		}

		if o.OnCommandError != nil {
			h.options.OnCommandError = o.OnCommandError
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

func (c *CommandHandler) UnregisterCommands() {
	if c.options.CommandStore != nil {
		return
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
				c.options.OnSystemError(err)
			} else {
				c.idCache[name] = cachedCommand.ID
			}
		}
	}

	if len(update) > 0 {
		_, err = s.ApplicationCommandBulkOverwrite(e.User.ID, "", update)
		if err != nil {
			c.options.OnSystemError(err)
		}
	}

	if c.options.CommandStore != nil {
		err = c.options.CommandStore.Store(c.idCache)
		if err != nil {
			c.options.OnSystemError(err)
		}
	}
}

func (c *CommandHandler) onInteractionCreate(s *discordgo.Session, e *discordgo.InteractionCreate) {
	switch e.Type {
	case discordgo.InteractionApplicationCommand:
		c.appCommandInteraction(s, e)
	default:
		return
	}
}

func (c *CommandHandler) appCommandInteraction(s *discordgo.Session, e *discordgo.InteractionCreate) {
	cmd := c.cmds[e.ApplicationCommandData().Name]
	if cmd == nil {
		return
	}

	err := cmd.Exec(s, e.Interaction)
	if err != nil {
		c.options.OnSystemError(err)
	}
}
