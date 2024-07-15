package state

import "github.com/bwmarrin/discordgo"

// SessionWrapped is a wrapper for the internal state of the discordgo.Session
type SessionWrapped struct {
}

func NewSessionWrapped() *SessionWrapped {
	return &SessionWrapped{}
}

func (sw *SessionWrapped) SelfUser(s *discordgo.Session) (self *discordgo.User, err error) {
	self = s.State.User

	return
}

func (sw *SessionWrapped) Channel(s *discordgo.Session, id string) (channel *discordgo.Channel, err error) {
	if channel, err = s.State.Channel(id); err != nil && err != discordgo.ErrStateNotFound {
		return
	}

	if channel == nil {
		channel, err = s.Channel(id)
		if err != nil {
			return
		}

		s.State.ChannelAdd(channel)

		return
	}

	return
}

func (sw *SessionWrapped) Guild(s *discordgo.Session, id string) (guild *discordgo.Guild, err error) {
	if guild, err = s.State.Guild(id); err != nil && err != discordgo.ErrStateNotFound {
		return
	}

	if guild == nil {
		guild, err = s.Guild(id)
		if err != nil {
			return
		}

		s.State.GuildAdd(guild)

		return
	}

	return
}

func (sw *SessionWrapped) Role(s *discordgo.Session, guildID, roleID string) (role *discordgo.Role, err error) {
	guild, err := sw.Guild(s, guildID)
	if err != nil {
		return
	}

	for _, r := range guild.Roles {
		if r.ID == roleID {
			role = r

			s.State.RoleAdd(guild.ID, role)

			return
		}
	}

	return
}

func (sw *SessionWrapped) User(s *discordgo.Session, id string) (user *discordgo.User, err error) {
	user, err = s.User(id)

	return
}
