package state

import "github.com/bwmarrin/discordgo"

type State interface {
	// SelfMember returns the discordgo.User of the bot itself
	SelfUser(s *discordgo.Session) (self *discordgo.User, err error)

	// Channel returns the discordgo.Channel of the given id
	Channel(s *discordgo.Session, id string) (channel *discordgo.Channel, err error)

	// Guild returns the discordgo.Guild of the given id
	Guild(s *discordgo.Session, id string) (guild *discordgo.Guild, err error)

	// Role returns the discordgo.Role of the given guildID and roleID
	Role(s *discordgo.Session, guildID, roleID string) (role *discordgo.Role, err error)

	// User returns the discordgo.User of the given id
	User(s *discordgo.Session, id string) (user *discordgo.User, err error)
}
