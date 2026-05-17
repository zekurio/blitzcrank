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
	"golang.org/x/image/vector"
)

const (
	releaseCalendarDefaultSpan = "week"
)

var (
	sonarrReleaseColor = color.RGBA{R: 24, G: 172, B: 219, A: 255}
	radarrReleaseColor = color.RGBA{R: 232, G: 160, B: 32, A: 255}
)

var (
	releaseCalendarBackgroundColor  = color.RGBA{R: 11, G: 11, B: 12, A: 255}
	releaseCalendarCellColor        = color.RGBA{R: 31, G: 31, B: 34, A: 255}
	releaseCalendarMutedCellColor   = color.RGBA{R: 23, G: 23, B: 25, A: 255}
	releaseCalendarBorderColor      = color.RGBA{R: 61, G: 61, B: 66, A: 255}
	releaseCalendarMutedBorderColor = color.RGBA{R: 43, G: 43, B: 47, A: 255}
	releaseCalendarInkColor         = color.RGBA{R: 12, G: 12, B: 13, A: 255}
)

//go:embed assets/fonts/OpenSans-Regular.ttf
var releaseCalendarFontData []byte

//go:embed assets/fonts/OpenSans-SemiBold.ttf
var releaseCalendarSemiBoldFontData []byte

//go:embed assets/fonts/OpenSans-Bold.ttf
var releaseCalendarBoldFontData []byte

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
	items, warnings, err := b.fetchReleaseCalendarItems(ctx, calendarGridStart(start), calendarGridEnd(end))
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
		for _, release := range radarrReleaseDates(object, movie) {
			items = append(items, releaseCalendarItem{
				Service: "Radarr",
				Date:    release.Date,
				Title:   title + " - " + release.Kind,
				Color:   radarrReleaseColor,
			})
		}
	}
	return items
}

type radarrReleaseDate struct {
	Date time.Time
	Kind string
}

func radarrReleaseDates(object, movie map[string]any) []radarrReleaseDate {
	candidates := []struct {
		kind   string
		values []any
	}{
		{kind: "Digital", values: []any{object["digitalRelease"], movie["digitalRelease"]}},
		{kind: "Physical", values: []any{object["physicalRelease"], movie["physicalRelease"]}},
		{kind: "Cinemas", values: []any{object["inCinemas"], movie["inCinemas"]}},
		{kind: "Release", values: []any{object["releaseDate"], movie["releaseDate"]}},
	}
	var releases []radarrReleaseDate
	seen := map[string]bool{}
	for _, candidate := range candidates {
		date, ok := parseReleaseTime(candidate.values...)
		if !ok {
			continue
		}
		key := candidate.kind + ":" + date.Format("2006-01-02")
		if seen[key] {
			continue
		}
		seen[key] = true
		releases = append(releases, radarrReleaseDate{Date: date, Kind: candidate.kind})
	}
	return releases
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
	const width = 1400
	const margin = 36
	const headerHeight = 118
	const weekdayHeight = 30
	const dayHeaderHeight = 24
	const rowGap = 12
	const cellPadding = 8
	const dateReleaseGap = 8
	const chipPadding = 6
	const itemGap = 4
	const chipRadius = 5
	const cellRadius = 5

	face, err := releaseCalendarFontFace()
	if err != nil {
		return nil, err
	}
	defer face.Close()
	boldFace, err := releaseCalendarBoldFontFace()
	if err != nil {
		return nil, err
	}
	defer boldFace.Close()
	semiBoldFace, err := releaseCalendarSemiBoldFontFace()
	if err != nil {
		return nil, err
	}
	defer semiBoldFace.Close()
	chipMetrics := semiBoldFace.Metrics()
	chipAscent := chipMetrics.Ascent.Ceil()
	chipDescent := chipMetrics.Descent.Ceil()
	chipLineHeight := chipMetrics.Height.Ceil()
	dateAscent := face.Metrics().Ascent.Ceil()

	gridStart := calendarGridStart(start)
	gridEnd := calendarGridEnd(end)
	days := int(gridEnd.Sub(gridStart).Hours() / 24)
	if days < 1 {
		days = 1
	}
	rows := (days + 6) / 7
	byDay := map[int][]releaseCalendarItem{}
	for _, item := range items {
		index := int(dayStart(item.Date).Sub(gridStart).Hours() / 24)
		if index < 0 || index >= days {
			continue
		}
		byDay[index] = append(byDay[index], item)
	}

	cellWidth := (width - margin*2) / 7
	chipTextWidth := cellWidth - cellPadding*2 - 14 - chipPadding*2

	dayHeights := make([]int, days)
	for i := 0; i < days; i++ {
		h := dayHeaderHeight + cellPadding
		if len(byDay[i]) > 0 {
			h += dateReleaseGap
		}
		for idx, item := range byDay[i] {
			lines := wrapCalendarText(semiBoldFace, item.Title, chipTextWidth)
			itemH := chipHeight(len(lines), chipPadding, chipAscent, chipDescent, chipLineHeight)
			h += itemH
			if idx < len(byDay[i])-1 {
				h += itemGap
			}
		}
		if len(byDay[i]) > 0 {
			h += cellPadding
		}
		dayHeights[i] = h
	}

	rowHeights := make([]int, rows)
	for i, h := range dayHeights {
		r := i / 7
		if h > rowHeights[r] {
			rowHeights[r] = h
		}
	}
	for r := range rowHeights {
		if rowHeights[r] < 48 {
			rowHeights[r] = 48
		}
	}

	gridHeight := weekdayHeight
	for _, h := range rowHeights {
		gridHeight += h + rowGap
	}

	warningHeight := 0
	if len(warnings) > 0 {
		warningHeight = 28 + len(warnings)*18
	}
	height := margin*2 + headerHeight + gridHeight + warningHeight

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: releaseCalendarBackgroundColor}, image.Point{}, draw.Src)
	drawText(img, boldFace, margin, 50, "Release-Kalender", color.RGBA{R: 241, G: 245, B: 249, A: 255})
	drawText(img, face, margin, 76, label, color.RGBA{R: 148, G: 163, B: 184, A: 255})
	drawLegend(img, face, width-margin-420, 42, "Sonarr (Serien)", sonarrReleaseColor)
	drawLegend(img, face, width-margin-210, 42, "Radarr (Filme)", radarrReleaseColor)

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
			fill := releaseCalendarCellColor
			border := releaseCalendarBorderColor
			if index >= days {
				fill = releaseCalendarMutedCellColor
				border = releaseCalendarMutedBorderColor
			}
			fillRoundedRect(img, rect, cellRadius, border)
			fillRoundedRect(img, image.Rect(rect.Min.X+1, rect.Min.Y+1, rect.Max.X-1, rect.Max.Y-1), cellRadius-1, fill)
			if index < days {
				day := gridStart.AddDate(0, 0, index)
				dayColor := color.RGBA{R: 226, G: 232, B: 240, A: 255}
				if day.Before(start) || !day.Before(end) {
					dayColor = color.RGBA{R: 148, G: 163, B: 184, A: 255}
				}
				drawText(img, face, x+cellPadding, y+cellPadding+dateAscent, day.Format("02.01."), dayColor)
				itemY := y + dayHeaderHeight + cellPadding + dateReleaseGap
				for idx, item := range byDay[index] {
					lines := wrapCalendarText(semiBoldFace, item.Title, chipTextWidth)
					itemH := chipHeight(len(lines), chipPadding, chipAscent, chipDescent, chipLineHeight)
					chip := image.Rect(x+cellPadding, itemY, x+cellWidth-14, itemY+itemH)
					fillRoundedRect(img, chip, chipRadius, item.Color)
					textY := chip.Min.Y + chipPadding + chipAscent
					for _, line := range lines {
						drawText(img, semiBoldFace, chip.Min.X+chipPadding, textY, line, releaseCalendarInkColor)
						textY += chipLineHeight
					}
					itemY += itemH
					if idx < len(byDay[index])-1 {
						itemY += itemGap
					}
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

func calendarGridStart(start time.Time) time.Time {
	start = dayStart(start)
	offset := (int(start.Weekday()) + 6) % 7
	return start.AddDate(0, 0, -offset)
}

func calendarGridEnd(end time.Time) time.Time {
	lastDay := dayStart(end).AddDate(0, 0, -1)
	offset := (7 - int(lastDay.Weekday())) % 7
	return lastDay.AddDate(0, 0, offset+1)
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

func releaseCalendarSemiBoldFontFace() (font.Face, error) {
	parsed, err := opentype.Parse(releaseCalendarSemiBoldFontData)
	if err != nil {
		return nil, fmt.Errorf("parse embedded release calendar semibold font: %w", err)
	}
	return opentype.NewFace(parsed, &opentype.FaceOptions{
		Size:    13,
		DPI:     96,
		Hinting: font.HintingFull,
	})
}

func releaseCalendarBoldFontFace() (font.Face, error) {
	parsed, err := opentype.Parse(releaseCalendarBoldFontData)
	if err != nil {
		return nil, fmt.Errorf("parse embedded release calendar bold font: %w", err)
	}
	return opentype.NewFace(parsed, &opentype.FaceOptions{
		Size:    13,
		DPI:     96,
		Hinting: font.HintingFull,
	})
}

func chipHeight(lineCount, padding, ascent, descent, lineHeight int) int {
	if lineCount < 1 {
		lineCount = 1
	}
	textHeight := ascent + descent
	if lineCount > 1 {
		textHeight += (lineCount - 1) * lineHeight
	}
	return padding*2 + textHeight
}

func drawLegend(img *image.RGBA, face font.Face, x, y int, label string, c color.RGBA) {
	fillRoundedRect(img, image.Rect(x, y, x+18, y+18), 5, c)
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

func fillRoundedRect(img *image.RGBA, rect image.Rectangle, r int, c color.Color) {
	rect = rect.Intersect(img.Bounds())
	if rect.Empty() {
		return
	}
	if r <= 0 {
		draw.Draw(img, rect, &image.Uniform{C: c}, image.Point{}, draw.Src)
		return
	}
	maxRadius := min(rect.Dx(), rect.Dy()) / 2
	if r > maxRadius {
		r = maxRadius
	}

	const kappa = 0.55228475
	x0, y0 := float32(rect.Min.X), float32(rect.Min.Y)
	x1, y1 := float32(rect.Max.X), float32(rect.Max.Y)
	radius := float32(r)
	control := radius * kappa

	bounds := img.Bounds()
	rasterizer := vector.NewRasterizer(bounds.Dx(), bounds.Dy())
	rasterizer.MoveTo(x0+radius, y0)
	rasterizer.LineTo(x1-radius, y0)
	rasterizer.CubeTo(x1-radius+control, y0, x1, y0+radius-control, x1, y0+radius)
	rasterizer.LineTo(x1, y1-radius)
	rasterizer.CubeTo(x1, y1-radius+control, x1-radius+control, y1, x1-radius, y1)
	rasterizer.LineTo(x0+radius, y1)
	rasterizer.CubeTo(x0+radius-control, y1, x0, y1-radius+control, x0, y1-radius)
	rasterizer.LineTo(x0, y0+radius)
	rasterizer.CubeTo(x0, y0+radius-control, x0+radius-control, y0, x0+radius, y0)
	rasterizer.ClosePath()
	rasterizer.Draw(img, bounds, &image.Uniform{C: c}, image.Point{})
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

func measureStringWidth(face font.Face, text string) int {
	return font.MeasureString(face, text).Ceil()
}

func truncateToWidth(face font.Face, text string, maxWidth int) string {
	if measureStringWidth(face, text) <= maxWidth {
		return text
	}
	runes := []rune(text)
	low, high := 0, len(runes)
	for low < high {
		mid := (low + high + 1) / 2
		t := string(runes[:mid]) + "..."
		if measureStringWidth(face, t) <= maxWidth {
			low = mid
		} else {
			high = mid - 1
		}
	}
	if low == 0 {
		return "..."
	}
	return string(runes[:low]) + "..."
}

func wrapCalendarText(face font.Face, text string, maxWidth int) []string {
	if maxWidth <= 0 {
		return []string{text}
	}
	words := strings.Fields(text)
	if len(words) == 0 {
		return nil
	}
	var lines []string
	currentLine := words[0]
	for _, word := range words[1:] {
		testLine := currentLine + " " + word
		if measureStringWidth(face, testLine) <= maxWidth {
			currentLine = testLine
		} else {
			lines = append(lines, truncateToWidth(face, currentLine, maxWidth))
			currentLine = word
		}
	}
	lines = append(lines, truncateToWidth(face, currentLine, maxWidth))
	return lines
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
