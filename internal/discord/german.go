package discord

import "fmt"

func germanPlural(count int, singular, plural string) string {
	if count == 1 {
		return singular
	}
	return plural
}

func germanCountPhrase(count int, singular, plural string) string {
	return fmt.Sprintf("%d %s", count, germanPlural(count, singular, plural))
}
