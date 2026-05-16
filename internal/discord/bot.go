package discord

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"

	"github.com/bwmarrin/discordgo"
)

type Bot struct {
	cfg     config.Config
	agent   *agent.Agent
	session *discordgo.Session
}

func NewBot(cfg config.Config, assistant *agent.Agent) (*Bot, error) {
	session, err := discordgo.New("Bot " + cfg.DiscordToken)
	if err != nil {
		return nil, err
	}
	session.Identify.Intents = discordgo.IntentsGuildMessages | discordgo.IntentsMessageContent

	bot := &Bot{cfg: cfg, agent: assistant, session: session}
	session.AddHandler(bot.onMessageCreate)
	return bot, nil
}

func (b *Bot) Start() error {
	return b.session.Open()
}

func (b *Bot) Close() {
	b.session.Close()
}

func (b *Bot) SendMessage(ctx context.Context, content string) error {
	if strings.TrimSpace(content) == "" {
		return nil
	}
	for _, chunk := range splitDiscordMessage(content) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			if _, err := b.session.ChannelMessageSend(b.cfg.AgentDiscordChannelID, chunk); err != nil {
				return err
			}
		}
	}
	return nil
}

func (b *Bot) onMessageCreate(session *discordgo.Session, event *discordgo.MessageCreate) {
	if event.Author == nil || event.Author.Bot || event.ChannelID != b.cfg.AgentDiscordChannelID {
		return
	}

	content := strings.TrimSpace(event.Content)
	if content == "" {
		return
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		if err := session.ChannelTyping(event.ChannelID); err != nil {
			log.Printf("send typing indicator: %v", err)
		}

		reply, err := b.agent.Respond(ctx, agent.Request{
			Source:  "discord",
			Author:  fmt.Sprintf("%s (%s)", event.Author.Username, event.Author.ID),
			Content: content,
		})
		if err != nil {
			log.Printf("agent discord response failed: %v", err)
			reply = "I could not process that request. Check the bot logs for details."
		}
		if err := b.SendMessage(ctx, reply); err != nil {
			log.Printf("send discord response failed: %v", err)
		}
	}()
}

func splitDiscordMessage(content string) []string {
	const limit = 1900
	content = strings.TrimSpace(content)
	if len(content) <= limit {
		return []string{content}
	}

	var chunks []string
	for len(content) > limit {
		cut := strings.LastIndex(content[:limit], "\n")
		if cut < 1 {
			cut = limit
		}
		chunks = append(chunks, strings.TrimSpace(content[:cut]))
		content = strings.TrimSpace(content[cut:])
	}
	if content != "" {
		chunks = append(chunks, content)
	}
	return chunks
}
