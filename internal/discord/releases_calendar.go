package discord

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"sort"
	"strconv"
	"strings"
	"time"

	"blitzcrank/internal/tools"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

const (
	releaseCalendarDefaultSpan = "week"
)

var (
	sonarrReleaseColor = color.RGBA{R: 24, G: 172, B: 219, A: 255}
	radarrReleaseColor = color.RGBA{R: 232, G: 160, B: 32, A: 255}
)

//go:embed assets/fonts/OpenSans-Regular.ttf
var releaseCalendarFontData []byte

type releaseCalendarItem struct {
	Service string
	Date    time.Time
	Title   string
	Color   color.RGBA
}

func releaseCalendarSpan(span string, now time.Time) (time.Time, time.Time, string, error) {
	location := now.Location()
	localNow := now.In(location)
	day := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	switch normalizeReleaseCalendarSpan(span) {
	case releaseCalendarDefaultSpan:
		start := day.AddDate(0, 0, -int((int(day.Weekday())+6)%7))
		end := start.AddDate(0, 0, 7)
		return start, end, "diese Woche (" + releaseCalendarDateRange(start, end) + ")", nil
	case "today":
		start := day
		end := start.AddDate(0, 0, 1)
		return start, end, "heute (" + start.Format("2006-01-02") + ")", nil
	case "month":
		start := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, location)
		end := start.AddDate(0, 1, 0)
		return start, end, "dieser Monat (" + releaseCalendarDateRange(start, end) + ")", nil
	default:
		return time.Time{}, time.Time{}, "", fmt.Errorf("Unbekannter Zeitraum. Erlaubt sind heute, woche oder monat.")
	}
}

func normalizeReleaseCalendarSpan(span string) string {
	switch strings.ToLower(strings.TrimSpace(span)) {
	case "", releaseCalendarDefaultSpan, "woche", "diese-woche", "diese_woche":
		return "week"
	case "today", "heute":
		return "today"
	case "month", "monat", "dieser-monat", "dieser_monat":
		return "month"
	default:
		return strings.ToLower(strings.TrimSpace(span))
	}
}

func releaseCalendarDateRange(start, end time.Time) string {
	return start.Format("2006-01-02") + " bis " + end.AddDate(0, 0, -1).Format("2006-01-02")
}

func (b *Bot) releaseCalendarPNG(ctx context.Context, start, end time.Time, label string) ([]byte, int, error) {
	items, warnings, err := b.fetchReleaseCalendarItems(ctx, start, end)
	if err != nil {
		return nil, 0, err
	}
	data, err := renderReleaseCalendarPNG(start, end, label, items, warnings)
	if err != nil {
		return nil, 0, err
	}
	return data, len(items), nil
}

func (b *Bot) fetchReleaseCalendarItems(ctx context.Context, start, end time.Time) ([]releaseCalendarItem, []string, error) {
	registry := tools.NewRegistry(b.cfg)
	args := map[string]any{
		"start":       start.Format("2006-01-02"),
		"end":         end.Format("2006-01-02"),
		"unmonitored": false,
	}
	var items []releaseCalendarItem
	var warnings []string
	sonarrResult, sonarrErr := registry.Call(ctx, "sonarr_get_calendar", args)
	if sonarrErr != nil {
		warnings = append(warnings, "Sonarr: "+sonarrErr.Error())
	} else {
		items = append(items, sonarrCalendarItems(sonarrResult)...)
	}
	radarrResult, radarrErr := registry.Call(ctx, "radarr_get_calendar", args)
	if radarrErr != nil {
		warnings = append(warnings, "Radarr: "+radarrErr.Error())
	} else {
		items = append(items, radarrCalendarItems(radarrResult)...)
	}
	if sonarrErr != nil && radarrErr != nil {
		return nil, warnings, fmt.Errorf("Sonarr und Radarr konnten nicht gelesen werden")
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Date.Equal(items[j].Date) {
			return items[i].Title < items[j].Title
		}
		return items[i].Date.Before(items[j].Date)
	})
	return items, warnings, nil
}

func sonarrCalendarItems(value any) []releaseCalendarItem {
	records, _ := value.([]any)
	items := make([]releaseCalendarItem, 0, len(records))
	for _, record := range records {
		object, ok := record.(map[string]any)
		if !ok {
			continue
		}
		date, ok := parseReleaseTime(object["airDateUtc"], object["airDate"])
		if !ok {
			continue
		}
		title := strings.TrimSpace(stringFromMap(object, "title"))
		if series, ok := object["series"].(map[string]any); ok {
			seriesTitle := strings.TrimSpace(stringFromMap(series, "title"))
			if seriesTitle != "" {
				title = seriesTitle + " " + sonarrEpisodeLabel(object, title)
			}
		}
		if title == "" {
			title = "Sonarr release"
		}
		items = append(items, releaseCalendarItem{Service: "Sonarr", Date: date, Title: title, Color: sonarrReleaseColor})
	}
	return items
}

func radarrCalendarItems(value any) []releaseCalendarItem {
	records, _ := value.([]any)
	items := make([]releaseCalendarItem, 0, len(records))
	for _, record := range records {
		object, ok := record.(map[string]any)
		if !ok {
			continue
		}
		movie, _ := object["movie"].(map[string]any)
		date, ok := parseReleaseTime(
			object["digitalRelease"],
			object["physicalRelease"],
			object["inCinemas"],
			object["releaseDate"],
			movie["digitalRelease"],
			movie["physicalRelease"],
			movie["inCinemas"],
			movie["releaseDate"],
		)
		if !ok {
			continue
		}
		title := strings.TrimSpace(stringFromMap(object, "title"))
		if title == "" {
			title = strings.TrimSpace(stringFromMap(movie, "title"))
		}
		if year := intFromInterface(object["year"]); year > 0 && title != "" {
			title += " (" + strconv.Itoa(year) + ")"
		} else if year := intFromInterface(movie["year"]); year > 0 && title != "" {
			title += " (" + strconv.Itoa(year) + ")"
		}
		if title == "" {
			title = "Radarr release"
		}
		items = append(items, releaseCalendarItem{Service: "Radarr", Date: date, Title: title, Color: radarrReleaseColor})
	}
	return items
}

func sonarrEpisodeLabel(object map[string]any, episodeTitle string) string {
	season := intFromInterface(object["seasonNumber"])
	episode := intFromInterface(object["episodeNumber"])
	if season == 0 && episode == 0 {
		return strings.TrimSpace(episodeTitle)
	}
	label := fmt.Sprintf("S%02dE%02d", season, episode)
	if strings.TrimSpace(episodeTitle) != "" {
		label += " - " + strings.TrimSpace(episodeTitle)
	}
	return label
}

func parseReleaseTime(values ...any) (time.Time, bool) {
	for _, value := range values {
		text, ok := value.(string)
		if !ok || strings.TrimSpace(text) == "" {
			continue
		}
		text = strings.TrimSpace(text)
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
			parsed, err := time.Parse(layout, text)
			if err == nil {
				return parsed, true
			}
		}
	}
	return time.Time{}, false
}

func renderReleaseCalendarPNG(start, end time.Time, label string, items []releaseCalendarItem, warnings []string) ([]byte, error) {
	const width = 1280
	const margin = 36
	const headerHeight = 118
	const weekdayHeight = 30
	const dayHeaderHeight = 24
	const itemHeight = 22
	const rowGap = 12
	const cellPadding = 8
	days := int(end.Sub(start).Hours() / 24)
	if days < 1 {
		days = 1
	}
	rows := (days + 6) / 7
	byDay := map[int][]releaseCalendarItem{}
	maxItemsInRow := make([]int, rows)
	for _, item := range items {
		index := int(dayStart(item.Date).Sub(start).Hours() / 24)
		if index < 0 || index >= days {
			continue
		}
		byDay[index] = append(byDay[index], item)
		row := index / 7
		if len(byDay[index]) > maxItemsInRow[row] {
			maxItemsInRow[row] = len(byDay[index])
		}
	}
	rowHeights := make([]int, rows)
	gridHeight := weekdayHeight
	for row := range rowHeights {
		rowHeights[row] = dayHeaderHeight + cellPadding*2 + max(1, maxItemsInRow[row])*itemHeight
		if rowHeights[row] < 112 {
			rowHeights[row] = 112
		}
		gridHeight += rowHeights[row] + rowGap
	}
	warningHeight := 0
	if len(warnings) > 0 {
		warningHeight = 28 + len(warnings)*18
	}
	height := margin*2 + headerHeight + gridHeight + warningHeight
	face, err := releaseCalendarFontFace()
	if err != nil {
		return nil, err
	}
	defer face.Close()

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: color.RGBA{R: 15, G: 23, B: 42, A: 255}}, image.Point{}, draw.Src)
	drawText(img, face, margin, 50, "Release-Kalender", color.RGBA{R: 241, G: 245, B: 249, A: 255})
	drawText(img, face, margin, 76, label, color.RGBA{R: 148, G: 163, B: 184, A: 255})
	drawLegend(img, face, width-margin-280, 42, "Sonarr", sonarrReleaseColor)
	drawLegend(img, face, width-margin-160, 42, "Radarr", radarrReleaseColor)
	cellWidth := (width - margin*2) / 7
	y := margin + headerHeight
	for i, weekday := range []string{"Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"} {
		drawText(img, face, margin+i*cellWidth+cellPadding, y+18, weekday, color.RGBA{R: 203, G: 213, B: 225, A: 255})
	}
	y += weekdayHeight
	for row := 0; row < rows; row++ {
		rowHeight := rowHeights[row]
		for col := 0; col < 7; col++ {
			index := row*7 + col
			x := margin + col*cellWidth
			rect := image.Rect(x, y, x+cellWidth-6, y+rowHeight)
			fill := color.RGBA{R: 30, G: 41, B: 59, A: 255}
			if index >= days {
				fill = color.RGBA{R: 23, G: 32, B: 48, A: 255}
			}
			draw.Draw(img, rect, &image.Uniform{C: fill}, image.Point{}, draw.Src)
			drawRectBorder(img, rect, color.RGBA{R: 51, G: 65, B: 85, A: 255})
			if index < days {
				day := start.AddDate(0, 0, index)
				drawText(img, face, x+cellPadding, y+18, day.Format("02.01."), color.RGBA{R: 226, G: 232, B: 240, A: 255})
				itemY := y + dayHeaderHeight + cellPadding
				for _, item := range byDay[index] {
					chip := image.Rect(x+cellPadding, itemY, x+cellWidth-14, itemY+itemHeight-4)
					draw.Draw(img, chip, &image.Uniform{C: item.Color}, image.Point{}, draw.Src)
					drawText(img, face, chip.Min.X+6, chip.Min.Y+14, compactCalendarText(item.Title, 18), color.RGBA{R: 15, G: 23, B: 42, A: 255})
					itemY += itemHeight
				}
			}
		}
		y += rowHeight + rowGap
	}
	if len(warnings) > 0 {
		drawText(img, face, margin, y+18, "Hinweise", color.RGBA{R: 203, G: 213, B: 225, A: 255})
		y += 28
		for _, warning := range warnings {
			drawText(img, face, margin, y+14, compactCalendarText(warning, 150), color.RGBA{R: 252, G: 165, B: 165, A: 255})
			y += 18
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func dayStart(value time.Time) time.Time {
	value = value.Local()
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, value.Location())
}

func releaseCalendarFontFace() (font.Face, error) {
	parsed, err := opentype.Parse(releaseCalendarFontData)
	if err != nil {
		return nil, fmt.Errorf("parse embedded release calendar font: %w", err)
	}
	return opentype.NewFace(parsed, &opentype.FaceOptions{
		Size:    13,
		DPI:     96,
		Hinting: font.HintingFull,
	})
}

func drawLegend(img *image.RGBA, face font.Face, x, y int, label string, c color.RGBA) {
	draw.Draw(img, image.Rect(x, y, x+18, y+18), &image.Uniform{C: c}, image.Point{}, draw.Src)
	drawText(img, face, x+26, y+14, label, color.RGBA{R: 226, G: 232, B: 240, A: 255})
}

func drawText(img *image.RGBA, face font.Face, x, y int, text string, c color.Color) {
	d := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(c),
		Face: face,
		Dot:  fixed.P(x, y),
	}
	d.DrawString(text)
}

func drawRectBorder(img *image.RGBA, rect image.Rectangle, c color.Color) {
	draw.Draw(img, image.Rect(rect.Min.X, rect.Min.Y, rect.Max.X, rect.Min.Y+1), &image.Uniform{C: c}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(rect.Min.X, rect.Max.Y-1, rect.Max.X, rect.Max.Y), &image.Uniform{C: c}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(rect.Min.X, rect.Min.Y, rect.Min.X+1, rect.Max.Y), &image.Uniform{C: c}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(rect.Max.X-1, rect.Min.Y, rect.Max.X, rect.Max.Y), &image.Uniform{C: c}, image.Point{}, draw.Src)
}

func compactCalendarText(text string, maxRunes int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= maxRunes {
		return text
	}
	if maxRunes <= 1 {
		return string(runes[:maxRunes])
	}
	if maxRunes <= 3 {
		return string(runes[:maxRunes])
	}
	return string(runes[:maxRunes-3]) + "..."
}

func stringFromMap(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func intFromInterface(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	default:
		return 0
	}
}
