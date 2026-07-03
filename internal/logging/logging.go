package logging

import (
	"context"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
)

type Options struct {
	Level string
	Color bool
}

func SetupFromEnv() {
	level := strings.TrimSpace(os.Getenv("BLITZCRANK_LOG_LEVEL"))
	if level == "" {
		level = strings.TrimSpace(os.Getenv("LOG_LEVEL"))
	}
	color := strings.TrimSpace(os.Getenv("NO_COLOR")) == "" && strings.TrimSpace(os.Getenv("BLITZCRANK_NO_COLOR")) == ""
	Setup(Options{Level: level, Color: color})
}

func Setup(opts Options) {
	var level slog.Level
	switch strings.ToLower(strings.TrimSpace(opts.Level)) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	logger := slog.New(&prettyHandler{out: os.Stderr, level: level, color: opts.Color, mu: &sync.Mutex{}})
	slog.SetDefault(logger)
	log.SetFlags(0)
	log.SetOutput(&stdLogWriter{logger: logger})
}

type prettyHandler struct {
	out   io.Writer
	level slog.Level
	color bool
	mu    *sync.Mutex
	attrs []slog.Attr
	group string
}

func (h *prettyHandler) Enabled(_ context.Context, level slog.Level) bool { return level >= h.level }

func (h *prettyHandler) Handle(_ context.Context, record slog.Record) error {
	var b strings.Builder
	timeText := record.Time.Format("15:04:05")
	levelText := strings.ToUpper(record.Level.String())
	if record.Level == slog.LevelWarn {
		levelText = "WARN"
	}
	if h.color {
		b.WriteString(colorForLevel(record.Level))
	}
	b.WriteString(timeText)
	b.WriteString(" ")
	b.WriteString(fmt.Sprintf("%-5s", levelText))
	if h.color {
		b.WriteString("\x1b[0m")
	}
	b.WriteString(" ")
	b.WriteString(record.Message)
	attrs := append([]slog.Attr(nil), h.attrs...)
	record.Attrs(func(attr slog.Attr) bool {
		attrs = append(attrs, attr)
		return true
	})
	for _, attr := range attrs {
		attr.Value = attr.Value.Resolve()
		if attr.Equal(slog.Attr{}) {
			continue
		}
		b.WriteString(" ")
		if h.color {
			b.WriteString("\x1b[2m")
		}
		if h.group != "" {
			b.WriteString(h.group)
			b.WriteString(".")
		}
		b.WriteString(attr.Key)
		b.WriteString("=")
		b.WriteString(formatValue(attr.Value))
		if h.color {
			b.WriteString("\x1b[0m")
		}
	}
	b.WriteString("\n")
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.out, b.String())
	return err
}

func (h *prettyHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clone := *h
	clone.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	return &clone
}

func (h *prettyHandler) WithGroup(name string) slog.Handler {
	clone := *h
	if clone.group != "" {
		clone.group += "."
	}
	clone.group += name
	return &clone
}

func colorForLevel(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "\x1b[31m"
	case level >= slog.LevelWarn:
		return "\x1b[33m"
	case level <= slog.LevelDebug:
		return "\x1b[36m"
	default:
		return "\x1b[32m"
	}
}

func formatValue(value slog.Value) string {
	switch value.Kind() {
	case slog.KindString:
		text := value.String()
		if strings.ContainsAny(text, " \t\n\"") {
			return fmt.Sprintf("%q", text)
		}
		return text
	case slog.KindTime:
		return value.Time().Format(time.RFC3339)
	case slog.KindDuration:
		return value.Duration().String()
	default:
		return value.String()
	}
}

type stdLogWriter struct{ logger *slog.Logger }

func (w *stdLogWriter) Write(p []byte) (int, error) {
	msg := strings.TrimSpace(string(p))
	if msg != "" {
		w.logger.Info(msg)
	}
	return len(p), nil
}
