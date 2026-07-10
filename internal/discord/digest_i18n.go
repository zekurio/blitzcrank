package discord

import "github.com/bwmarrin/discordgo"

type digestCopy struct {
	SubscribeTitle       string
	SubscribeIntro       string
	TopicsPlaceholder    string
	ReleasesPlaceholder  string
	CadencePlaceholder   string
	Continue             string
	Cancel               string
	AnimeSeasons         string
	AnimeDescription     string
	ShowPremieres        string
	ShowDescription      string
	MovieReleases        string
	MovieDescription     string
	Online               string
	OnlineDescription    string
	Physical             string
	PhysicalDescription  string
	Cinema               string
	CinemaDescription    string
	Daily                string
	Weekly               string
	Seasonal             string
	SettingsTitle        string
	RegionLabel          string
	RegionPlaceholder    string
	TimezoneLabel        string
	TimezonePlaceholder  string
	TimeLabel            string
	TimePlaceholder      string
	WeekdayLabel         string
	WeekdayPlaceholder   string
	InterestsLabel       string
	InterestsPlaceholder string
	ChooseAll            string
	SubscriptionCreated  string
	SubscriptionUpdated  string
	SubscriptionExists   string
	SubscriptionLimit    string
	SubscriptionPaused   string
	SubscriptionResumed  string
	SubscriptionDeleted  string
	NoSubscriptions      string
	ManageTitle          string
	ManagePlaceholder    string
	Edit                 string
	Pause                string
	Resume               string
	Preview              string
	Delete               string
	ConfirmDelete        string
	DeleteNow            string
	Back                 string
	Canceled             string
	InvalidAction        string
	InvalidSettings      string
	InvalidCombination   string
	InternalError        string
	PreviewEmpty         string
	PreviewTitle         string
	DigestTitle          string
	TopicsLabel          string
	ReleasesLabel        string
	CadenceLabel         string
	ScheduleLabel        string
	Active               string
	Paused               string
	ReleaseDate          string
	SourceLabel          string
	MoreItems            string
	LinkTitle            string
	Link                 string
	Relink               string
	LinkedStatus         string
	JellyfinUsername     string
	JellyfinPassword     string
	LinkWarning          string
	LinkSuccess          string
	LinkFailed           string
	LinkUnavailable      string
	UnlinkSuccess        string
	NotLinked            string
	DMFooter             string
	PartialSources       string
}

var digestEnglish = digestCopy{
	SubscribeTitle:       "Create a media digest",
	SubscribeIntro:       "Choose what belongs in your private recommendation digest, then continue to delivery settings.",
	TopicsPlaceholder:    "1. Choose topics",
	ReleasesPlaceholder:  "2. Choose release lanes",
	CadencePlaceholder:   "3. Choose frequency",
	Continue:             "Continue",
	Cancel:               "Cancel",
	AnimeSeasons:         "Anime seasons",
	AnimeDescription:     "New seasonal anime from AniList",
	ShowPremieres:        "New shows",
	ShowDescription:      "Newly premiering TV shows",
	MovieReleases:        "New movies",
	MovieDescription:     "Upcoming regional movie releases",
	Online:               "Online / home",
	OnlineDescription:    "Broadcast and digital home releases",
	Physical:             "Physical / home",
	PhysicalDescription:  "Blu-ray, DVD, and other physical releases",
	Cinema:               "Cinema",
	CinemaDescription:    "Limited and wide theatrical releases",
	Daily:                "Daily",
	Weekly:               "Weekly",
	Seasonal:             "Seasonal",
	SettingsTitle:        "Digest delivery settings",
	RegionLabel:          "Release region",
	RegionPlaceholder:    "AT, DE, US, ...",
	TimezoneLabel:        "IANA time zone",
	TimezonePlaceholder:  "Europe/Vienna",
	TimeLabel:            "Delivery time (HH:MM)",
	TimePlaceholder:      "18:00",
	WeekdayLabel:         "Weekday (for weekly digests)",
	WeekdayPlaceholder:   "Friday",
	InterestsLabel:       "Interests (optional, comma-separated)",
	InterestsPlaceholder: "science fiction, thriller, comedy",
	ChooseAll:            "Choose at least one topic, release lane, and frequency.",
	SubscriptionCreated:  "Your digest subscription is ready. It will arrive by DM.",
	SubscriptionUpdated:  "Your digest subscription was updated.",
	SubscriptionExists:   "An identical digest subscription already exists. Change at least one setting.",
	SubscriptionLimit:    "You already have the maximum of 10 digest subscriptions.",
	SubscriptionPaused:   "The digest subscription is paused.",
	SubscriptionResumed:  "The digest subscription is active again.",
	SubscriptionDeleted:  "The digest subscription was deleted.",
	NoSubscriptions:      "You do not have any digest subscriptions yet.",
	ManageTitle:          "Manage media digests",
	ManagePlaceholder:    "Choose a subscription",
	Edit:                 "Edit",
	Pause:                "Pause",
	Resume:               "Resume",
	Preview:              "Preview",
	Delete:               "Delete",
	ConfirmDelete:        "Delete this subscription permanently?",
	DeleteNow:            "Delete permanently",
	Back:                 "Back",
	Canceled:             "Digest setup canceled.",
	InvalidAction:        "This digest form expired or belongs to another user. Run the command again.",
	InvalidSettings:      "Those settings are not valid. Check the region, time zone, time, and weekday.",
	InvalidCombination:   "Those topics and release lanes cannot produce a digest. Online releases work for every topic; physical and cinema releases require movies.",
	InternalError:        "I couldn't complete that digest action. Please try again.",
	PreviewEmpty:         "No matching releases were found in the next delivery window.",
	PreviewTitle:         "Your media digest preview",
	DigestTitle:          "Your media release digest",
	TopicsLabel:          "Topics",
	ReleasesLabel:        "Release lanes",
	CadenceLabel:         "Frequency",
	ScheduleLabel:        "Delivery",
	Active:               "Active",
	Paused:               "Paused",
	ReleaseDate:          "Release",
	SourceLabel:          "Source",
	MoreItems:            "More matching releases were omitted from this message.",
	LinkTitle:            "Link Jellyfin account",
	Link:                 "Link account",
	Relink:               "Replace account link",
	LinkedStatus:         "A Jellyfin account is already linked. Continuing replaces that link after the new credentials are verified.",
	JellyfinUsername:     "Jellyfin username",
	JellyfinPassword:     "Jellyfin password",
	LinkWarning:          "Discord modal fields are not password-masked. Your password, or an empty value for a passwordless account, is used once to verify the account and is never stored.",
	LinkSuccess:          "Your Jellyfin account is linked. Watch history can now improve recommendations.",
	LinkFailed:           "Jellyfin could not verify those credentials.",
	LinkUnavailable:      "Jellyfin account linking is unavailable. It requires a configured HTTPS or loopback Jellyfin URL.",
	UnlinkSuccess:        "Your Jellyfin account link was removed.",
	NotLinked:            "No Jellyfin account is linked.",
	DMFooter:             "Release data: TMDB and AniList. This product uses the TMDB API but is not endorsed or certified by TMDB. Home release dates are recommendations, not confirmation that an item is playable in Jellyfin.",
	PartialSources:       "Some release sources were temporarily unavailable, so this digest may be incomplete.",
}

var digestGerman = digestCopy{
	SubscribeTitle:       "Medien-Digest erstellen",
	SubscribeIntro:       "Wähle den Inhalt deines privaten Empfehlungs-Digests und danach die Zustellung.",
	TopicsPlaceholder:    "1. Themen auswählen",
	ReleasesPlaceholder:  "2. Veröffentlichungen auswählen",
	CadencePlaceholder:   "3. Häufigkeit auswählen",
	Continue:             "Weiter",
	Cancel:               "Abbrechen",
	AnimeSeasons:         "Anime-Saisons",
	AnimeDescription:     "Neue saisonale Anime von AniList",
	ShowPremieres:        "Neue Serien",
	ShowDescription:      "Neu startende TV-Serien",
	MovieReleases:        "Neue Filme",
	MovieDescription:     "Bevorstehende regionale Filmstarts",
	Online:               "Online / Zuhause",
	OnlineDescription:    "Ausstrahlungen und digitale Heimveröffentlichungen",
	Physical:             "Physisch / Zuhause",
	PhysicalDescription:  "Blu-ray, DVD und andere physische Veröffentlichungen",
	Cinema:               "Kino",
	CinemaDescription:    "Limitierte und reguläre Kinostarts",
	Daily:                "Täglich",
	Weekly:               "Wöchentlich",
	Seasonal:             "Saisonal",
	SettingsTitle:        "Digest-Zustellung",
	RegionLabel:          "Veröffentlichungsregion",
	RegionPlaceholder:    "AT, DE, US, ...",
	TimezoneLabel:        "IANA-Zeitzone",
	TimezonePlaceholder:  "Europe/Vienna",
	TimeLabel:            "Zustellzeit (HH:MM)",
	TimePlaceholder:      "18:00",
	WeekdayLabel:         "Wochentag (bei wöchentlich)",
	WeekdayPlaceholder:   "Freitag",
	InterestsLabel:       "Interessen (optional, kommagetrennt)",
	InterestsPlaceholder: "Science-Fiction, Thriller, Komödie",
	ChooseAll:            "Wähle mindestens ein Thema, eine Veröffentlichungsart und eine Häufigkeit.",
	SubscriptionCreated:  "Dein Digest-Abo ist eingerichtet und kommt per DM.",
	SubscriptionUpdated:  "Dein Digest-Abo wurde aktualisiert.",
	SubscriptionExists:   "Ein identisches Digest-Abo existiert bereits. Ändere mindestens eine Einstellung.",
	SubscriptionLimit:    "Du hast bereits die maximalen 10 Digest-Abos.",
	SubscriptionPaused:   "Das Digest-Abo ist pausiert.",
	SubscriptionResumed:  "Das Digest-Abo ist wieder aktiv.",
	SubscriptionDeleted:  "Das Digest-Abo wurde gelöscht.",
	NoSubscriptions:      "Du hast noch keine Digest-Abos.",
	ManageTitle:          "Medien-Digests verwalten",
	ManagePlaceholder:    "Abo auswählen",
	Edit:                 "Bearbeiten",
	Pause:                "Pausieren",
	Resume:               "Fortsetzen",
	Preview:              "Vorschau",
	Delete:               "Löschen",
	ConfirmDelete:        "Dieses Abo endgültig löschen?",
	DeleteNow:            "Endgültig löschen",
	Back:                 "Zurück",
	Canceled:             "Digest-Einrichtung abgebrochen.",
	InvalidAction:        "Dieses Digest-Formular ist abgelaufen oder gehört jemand anderem. Starte den Befehl erneut.",
	InvalidSettings:      "Diese Einstellungen sind ungültig. Prüfe Region, Zeitzone, Uhrzeit und Wochentag.",
	InvalidCombination:   "Diese Themen und Veröffentlichungsarten ergeben keinen Digest. Online-Veröffentlichungen funktionieren für alle Themen; physische und Kino-Veröffentlichungen benötigen Filme.",
	InternalError:        "Die Digest-Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
	PreviewEmpty:         "Im nächsten Zustellfenster wurden keine passenden Veröffentlichungen gefunden.",
	PreviewTitle:         "Vorschau deines Medien-Digests",
	DigestTitle:          "Dein Medien-Release-Digest",
	TopicsLabel:          "Themen",
	ReleasesLabel:        "Veröffentlichungsarten",
	CadenceLabel:         "Häufigkeit",
	ScheduleLabel:        "Zustellung",
	Active:               "Aktiv",
	Paused:               "Pausiert",
	ReleaseDate:          "Veröffentlichung",
	SourceLabel:          "Quelle",
	MoreItems:            "Weitere passende Veröffentlichungen wurden in dieser Nachricht ausgelassen.",
	LinkTitle:            "Jellyfin-Konto verknüpfen",
	Link:                 "Konto verknüpfen",
	Relink:               "Verknüpfung ersetzen",
	LinkedStatus:         "Ein Jellyfin-Konto ist bereits verknüpft. Beim Fortfahren wird die Verknüpfung nach erfolgreicher Prüfung ersetzt.",
	JellyfinUsername:     "Jellyfin-Benutzername",
	JellyfinPassword:     "Jellyfin-Passwort",
	LinkWarning:          "Discord-Modalfelder maskieren Passwörter nicht. Dein Passwort – oder ein leerer Wert bei einem passwortlosen Konto – wird einmalig geprüft und niemals gespeichert.",
	LinkSuccess:          "Dein Jellyfin-Konto ist verknüpft. Der Wiedergabeverlauf kann Empfehlungen verbessern.",
	LinkFailed:           "Jellyfin konnte diese Zugangsdaten nicht bestätigen.",
	LinkUnavailable:      "Die Jellyfin-Kontoverknüpfung ist nicht verfügbar. Dafür muss eine HTTPS- oder Loopback-Jellyfin-URL konfiguriert sein.",
	UnlinkSuccess:        "Die Verknüpfung mit Jellyfin wurde entfernt.",
	NotLinked:            "Es ist kein Jellyfin-Konto verknüpft.",
	DMFooter:             "Release-Daten: TMDB und AniList. This product uses the TMDB API but is not endorsed or certified by TMDB. Heimveröffentlichungen sind Empfehlungen und keine Bestätigung, dass ein Titel in Jellyfin abspielbar ist.",
	PartialSources:       "Einige Quellen waren vorübergehend nicht verfügbar; dieser Digest kann unvollständig sein.",
}

func digestCopyFor(locale discordgo.Locale) digestCopy {
	if locale == discordgo.German {
		return digestGerman
	}
	return digestEnglish
}

func canonicalDigestLocale(locale discordgo.Locale) string {
	if locale == discordgo.German {
		return string(discordgo.German)
	}
	if locale == discordgo.EnglishGB {
		return string(discordgo.EnglishGB)
	}
	return string(discordgo.EnglishUS)
}
