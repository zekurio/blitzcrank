import axios, { AxiosError } from "axios";
import { config } from "../../config";
import logger from "../../logger";
import type {
  Request,
  RequestsResponse,
  MovieDetails,
  TvDetails,
} from "./models";

class JellyseerrClient {
  private baseURL: string;
  private apiKey: string;

  constructor() {
    this.baseURL = config.jellyseerr.url;
    this.apiKey = config.jellyseerr.apiKey;
  }

  private async makeRequest<T>(
    url: string,
    params?: Record<string, any>
  ): Promise<T> {
    try {
      const response = await axios.get<T>(url, {
        headers: {
          "X-Api-Key": this.apiKey,
        },
        params,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        logger.error(`Jellyseerr API Error: ${axiosError.message}`, {
          status: axiosError.response?.status,
          data: axiosError.response?.data,
          config: axiosError.config,
        });
      } else {
        logger.error("Unexpected error in Jellyseerr API request:", error);
      }
      throw error;
    }
  }

  async jellyseerrStatus(): Promise<boolean> {
    try {
      await this.makeRequest(`${this.baseURL}/api/v1/status`);
      return true;
    } catch (error) {
      logger.error("Error testing Jellyseerr API status:", error);
      return false;
    }
  }

  async getRequests(
    take: number = 10,
    skip: number = 0,
    filter:
      | "all"
      | "available"
      | "unavailable"
      | "approved"
      | "pending"
      | "processing" = "all"
  ): Promise<RequestsResponse> {
    try {
      return await this.makeRequest<RequestsResponse>(
        `${this.baseURL}/api/v1/request`,
        {
          take,
          skip,
          filter,
        }
      );
    } catch (error) {
      logger.error("Error fetching requests from Jellyseerr API:", error);
      return {
        pageInfo: { pages: 0, pageSize: 0, results: 0, page: 0 },
        results: [],
      };
    }
  }

  async getRequestById(requestId: number): Promise<Request | null> {
    try {
      return await this.makeRequest<Request>(
        `${this.baseURL}/api/v1/request/${requestId}`
      );
    } catch (error) {
      logger.error(
        `Error fetching request ${requestId} from Jellyseerr API:`,
        error
      );
      return null;
    }
  }

  async getMovieDetails(tmdbId: number): Promise<MovieDetails | null> {
    try {
      return await this.makeRequest<MovieDetails>(
        `${this.baseURL}/api/v1/movie/${tmdbId}`
      );
    } catch (error) {
      logger.error(
        `Error fetching movie details for TMDB ID ${tmdbId} from Jellyseerr API:`,
        error
      );
      return null;
    }
  }

  async getTvDetails(tmdbId: number): Promise<TvDetails | null> {
    try {
      return await this.makeRequest<TvDetails>(
        `${this.baseURL}/api/v1/tv/${tmdbId}`
      );
    } catch (error) {
      logger.error(
        `Error fetching TV show details for TMDB ID ${tmdbId} from Jellyseerr API:`,
        error
      );
      return null;
    }
  }
}

export const jellyseerrClient = new JellyseerrClient();
