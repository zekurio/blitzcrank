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
    this.baseURL = `${config.jellyseerr.url}/api/v1`;
    this.apiKey = config.jellyseerr.apiKey;
  }

  private async makeRequest<T>(
    url: string,
    method: "GET" | "POST" = "GET",
    params?: Record<string, any>
  ): Promise<T> {
    try {
      const response = await axios({
        method,
        url,
        headers: {
          "X-Api-Key": this.apiKey,
        },
        params: method === "GET" ? params : undefined,
        data: method === "POST" ? params : undefined,
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
      await this.makeRequest(`${this.baseURL}/status`);
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
      | "processing"
      | "failed"
      | "declined" = "all"
  ): Promise<RequestsResponse> {
    try {
      let response: RequestsResponse;
      if (filter === "declined") {
        // Fetch all requests and filter for declined ones
        response = await this.makeRequest<RequestsResponse>(
          `${this.baseURL}/request`,
          "GET",
          {
            take: 0, // Fetch all requests
            skip: 0,
            filter: "all",
          }
        );
        // Filter for declined requests (status 3)
        response.results = response.results.filter(
          (request) => request.status === 3
        );
        // Adjust pageInfo
        response.pageInfo.results = response.results.length;
        response.pageInfo.pages = Math.ceil(response.results.length / take);
        // Apply pagination
        response.results = response.results.slice(skip, skip + take);
      } else {
        response = await this.makeRequest<RequestsResponse>(
          `${this.baseURL}/request`,
          "GET",
          {
            take,
            skip,
            filter,
          }
        );
      }
      return response;
    } catch (error) {
      logger.error("Error fetching requests from Jellyseerr API:", error);
      return {
        pageInfo: { pages: 0, pageSize: 0, results: 0, page: 0 },
        results: [],
      };
    }
  }

  async getRequestCount(
    filter:
      | "all"
      | "available"
      | "unavailable"
      | "approved"
      | "pending"
      | "processing"
      | "failed"
      | "declined" = "all"
  ): Promise<number> {
    try {
      if (filter === "declined") {
        const allRequests = await this.getRequests(0, 0, "all");
        return allRequests.results.filter((request) => request.status === 3)
          .length;
      } else {
        const requests = await this.getRequests(0, 0, filter);
        return requests.pageInfo.results;
      }
    } catch (error) {
      logger.error(`Error fetching request count from Jellyseerr API:`, error);
      return 0;
    }
  }

  async getRequestById(requestId: number): Promise<Request | null> {
    try {
      return await this.makeRequest<Request>(
        `${this.baseURL}/request/${requestId}`
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
        `${this.baseURL}/movie/${tmdbId}`
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
      return await this.makeRequest<TvDetails>(`${this.baseURL}/tv/${tmdbId}`);
    } catch (error) {
      logger.error(
        `Error fetching TV show details for TMDB ID ${tmdbId} from Jellyseerr API:`,
        error
      );
      return null;
    }
  }

  async approveRequest(requestId: number): Promise<void> {
    try {
      await this.makeRequest(
        `${this.baseURL}/request/${requestId}/approve`,
        "POST"
      );
    } catch (error) {
      logger.error(
        `Error accepting request ${requestId} from Jellyseerr API:`,
        error
      );
    }
  }

  async declineRequest(requestId: number): Promise<void> {
    try {
      await this.makeRequest(
        `${this.baseURL}/request/${requestId}/decline`,
        "POST"
      );
    } catch (error) {
      logger.error(
        `Error declining request ${requestId} from Jellyseerr API:`,
        error
      );
    }
  }
}

export const jellyseerrClient = new JellyseerrClient();
