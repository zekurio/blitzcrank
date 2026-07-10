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
	DMFooter             string
	PartialSources       string
}

var digestEnglish = digestCopy{
	SubscribeTitle:       "Create a media digest",
	SubscribeIntro:       "Choose which monitored Arr calendars belong in your private newsletter, then continue to delivery settings.",
	TopicsPlaceholder:    "1. Choose topics",
	ReleasesPlaceholder:  "2. Choose release lanes",
	CadencePlaceholder:   "3. Choose frequency",
	Continue:             "Continue",
	Cancel:               "Cancel",
	AnimeSeasons:         "Anime seasons",
	AnimeDescription:     "Anime managed in Sonarr",
	ShowPremieres:        "Shows and anime",
	ShowDescription:      "Monitored Sonarr episode air dates",
	MovieReleases:        "Movies",
	MovieDescription:     "Monitored Radarr cinema and home releases",
	Online:               "Online / home",
	OnlineDescription:    "Broadcast and digital home releases",
	Physical:             "Physical / home",
	PhysicalDescription:  "Blu-ray, DVD, and other physical releases",
	Cinema:               "Cinema",
	CinemaDescription:    "Limited and wide theatrical releases",
	Daily:                "Daily",
	Weekly:               "Weekly",
	Seasonal:             "Monthly",
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
	ChooseAll:            "Choose at least one calendar and a frequency.",
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
	InvalidSettings:      "Those settings are not valid. Check the time zone, time, and weekday.",
	InvalidCombination:   "Those topics and release lanes cannot produce a digest. Online releases work for every topic; physical and cinema releases require movies.",
	InternalError:        "I couldn't complete that digest action. Please try again.",
	PreviewEmpty:         "No monitored calendar entries were found in the next delivery window.",
	PreviewTitle:         "Your media digest preview",
	DigestTitle:          "Your media calendar newsletter",
	TopicsLabel:          "Topics",
	ReleasesLabel:        "Release lanes",
	CadenceLabel:         "Frequency",
	ScheduleLabel:        "Delivery",
	Active:               "Active",
	Paused:               "Paused",
	ReleaseDate:          "Release",
	SourceLabel:          "Source",
	MoreItems:            "More matching releases were omitted from this message.",
	DMFooter:             "Calendar data from Sonarr and Radarr. Dates reflect your monitored Arr metadata.",
	PartialSources:       "One calendar was temporarily unavailable, so this newsletter may be incomplete.",
}

var digestGerman = digestCopy{
	SubscribeTitle:       "Medien-Digest erstellen",
	SubscribeIntro:       "Wähle die überwachten Arr-Kalender für deinen privaten Newsletter und danach die Zustellung.",
	TopicsPlaceholder:    "1. Themen auswählen",
	ReleasesPlaceholder:  "2. Veröffentlichungen auswählen",
	CadencePlaceholder:   "3. Häufigkeit auswählen",
	Continue:             "Weiter",
	Cancel:               "Abbrechen",
	AnimeSeasons:         "Anime-Saisons",
	AnimeDescription:     "In Sonarr verwaltete Anime",
	ShowPremieres:        "Serien und Anime",
	ShowDescription:      "Überwachte Sonarr-Ausstrahlungstermine",
	MovieReleases:        "Filme",
	MovieDescription:     "Überwachte Radarr-Kino- und Heimstarts",
	Online:               "Online / Zuhause",
	OnlineDescription:    "Ausstrahlungen und digitale Heimveröffentlichungen",
	Physical:             "Physisch / Zuhause",
	PhysicalDescription:  "Blu-ray, DVD und andere physische Veröffentlichungen",
	Cinema:               "Kino",
	CinemaDescription:    "Limitierte und reguläre Kinostarts",
	Daily:                "Täglich",
	Weekly:               "Wöchentlich",
	Seasonal:             "Monatlich",
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
	ChooseAll:            "Wähle mindestens einen Kalender und eine Häufigkeit.",
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
	InvalidSettings:      "Diese Einstellungen sind ungültig. Prüfe Zeitzone, Uhrzeit und Wochentag.",
	InvalidCombination:   "Diese Themen und Veröffentlichungsarten ergeben keinen Digest. Online-Veröffentlichungen funktionieren für alle Themen; physische und Kino-Veröffentlichungen benötigen Filme.",
	InternalError:        "Die Digest-Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
	PreviewEmpty:         "Im nächsten Zustellfenster wurden keine überwachten Kalendereinträge gefunden.",
	PreviewTitle:         "Vorschau deines Medien-Digests",
	DigestTitle:          "Dein Medienkalender-Newsletter",
	TopicsLabel:          "Themen",
	ReleasesLabel:        "Veröffentlichungsarten",
	CadenceLabel:         "Häufigkeit",
	ScheduleLabel:        "Zustellung",
	Active:               "Aktiv",
	Paused:               "Pausiert",
	ReleaseDate:          "Veröffentlichung",
	SourceLabel:          "Quelle",
	MoreItems:            "Weitere passende Veröffentlichungen wurden in dieser Nachricht ausgelassen.",
	DMFooter:             "Kalenderdaten aus Sonarr und Radarr. Termine entsprechen deinen überwachten Arr-Metadaten.",
	PartialSources:       "Ein Kalender war vorübergehend nicht verfügbar; dieser Newsletter kann unvollständig sein.",
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
