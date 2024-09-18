export interface User {
  id: number;
  email: string;
  plexUsername: string | null;
  jellyfinUsername: string | null;
  username: string | null;
  recoveryLinkExpirationDate: string | null;
  userType: number;
  plexId: string | null;
  jellyfinUserId: string;
  jellyfinDeviceId: string;
  jellyfinAuthToken: string;
  plexToken: string | null;
  avatar: string;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  createdAt: string;
  updatedAt: string;
  requestCount: number;
  displayName: string;
  permissions: number;
  warnings: any[];
}

export interface Media {
  downloadStatus: any[];
  downloadStatus4k: any[];
  id: number;
  mediaType: "movie" | "tv";
  tmdbId: number;
  tvdbId: number | null;
  imdbId: string | null;
  status: number;
  status4k: number;
  createdAt: string;
  updatedAt: string;
  lastSeasonChange: string;
  mediaAddedAt: string;
  serviceId: number;
  serviceId4k: number | null;
  externalServiceId: number;
  externalServiceId4k: number | null;
  externalServiceSlug: string;
  externalServiceSlug4k: string | null;
  ratingKey: string | null;
  ratingKey4k: string | null;
  jellyfinMediaId: string;
  jellyfinMediaId4k: string | null;
  mediaUrl: string;
  serviceUrl: string;
}

export interface Request {
  id: number;
  status: number;
  createdAt: string;
  updatedAt: string;
  type: "movie" | "tv";
  is4k: boolean;
  serverId: number;
  profileId: number;
  rootFolder: string;
  languageProfileId: number | null;
  tags: string[];
  isAutoRequest: boolean;
  media: Media;
  seasons: any[];
  modifiedBy: User | null;
  requestedBy: User;
  seasonCount: number;
}

export interface RequestsResponse {
  pageInfo: {
    pages: number;
    pageSize: number;
    results: number;
    page: number;
  };
  results: Request[];
}

export type RequestStatus =
  | "all"
  | "available"
  | "unavailable"
  | "approved"
  | "pending"
  | "processing"
  | "failed"
  | "declined";

export interface MovieDetails {
  id: number;
  imdbId: string | null;
  adult: boolean;
  backdropPath: string | null;
  budget: number;
  genres: Genre[];
  homepage: string | null;
  originalLanguage: string;
  originalTitle: string;
  overview: string | null;
  popularity: number;
  posterPath: string | null;
  productionCompanies: ProductionCompany[];
  productionCountries: ProductionCountry[];
  releaseDate: string;
  revenue: number;
  runtime: number | null;
  spokenLanguages: SpokenLanguage[];
  status: string;
  tagline: string | null;
  title: string;
  video: boolean;
  voteAverage: number;
  voteCount: number;
  mediaInfo: MediaInfo | null;
  credits: Credits;
  externalIds: ExternalIds;
  mediaType: "movie";
}

export interface TvDetails {
  id: number;
  backdropPath: string | null;
  createdBy: Creator[];
  episodeRunTime: number[];
  firstAirDate: string;
  genres: Genre[];
  homepage: string;
  inProduction: boolean;
  languages: string[];
  lastAirDate: string;
  lastEpisodeToAir: Episode;
  name: string;
  nextEpisodeToAir: Episode | null;
  networks: Network[];
  numberOfEpisodes: number;
  numberOfSeasons: number;
  originCountry: string[];
  originalLanguage: string;
  originalName: string;
  overview: string;
  popularity: number;
  posterPath: string | null;
  productionCompanies: ProductionCompany[];
  productionCountries: ProductionCountry[];
  seasons: Season[];
  spokenLanguages: SpokenLanguage[];
  status: string;
  tagline: string;
  type: string;
  voteAverage: number;
  voteCount: number;
  mediaInfo: MediaInfo | null;
  credits: Credits;
  externalIds: ExternalIds;
  mediaType: "tv";
}

interface Genre {
  id: number;
  name: string;
}

interface ProductionCompany {
  id: number;
  logoPath: string | null;
  name: string;
  originCountry: string;
}

interface ProductionCountry {
  iso_3166_1: string;
  name: string;
}

interface SpokenLanguage {
  englishName: string;
  iso_639_1: string;
  name: string;
}

interface MediaInfo {
  downloadStatus: string[];
  downloadStatus4k: string[];
  status: number;
  status4k: number;
}

interface Credits {
  cast: CastMember[];
  crew: CrewMember[];
}

interface CastMember {
  id: number;
  name: string;
  profilePath: string | null;
  character: string;
  order: number;
}

interface CrewMember {
  id: number;
  name: string;
  profilePath: string | null;
  job: string;
  department: string;
}

interface ExternalIds {
  imdbId: string | null;
  freebaseMid: string | null;
  freebaseId: string | null;
  tvdbId: number | null;
  tvrageId: number | null;
  facebookId: string | null;
  instagramId: string | null;
  twitterId: string | null;
}

interface Creator {
  id: number;
  creditId: string;
  name: string;
  gender: number;
  profilePath: string | null;
}

interface Episode {
  airDate: string;
  episodeNumber: number;
  id: number;
  name: string;
  overview: string;
  productionCode: string;
  seasonNumber: number;
  stillPath: string | null;
  voteAverage: number;
  voteCount: number;
}

interface Network {
  name: string;
  id: number;
  logoPath: string | null;
  originCountry: string;
}

interface Season {
  airDate: string;
  episodeCount: number;
  id: number;
  name: string;
  overview: string;
  posterPath: string;
  seasonNumber: number;
}
