import { Jellyfin } from "@jellyfin/sdk";
import {
  ImageType,
  type BaseItemDto,
  type BaseItemDtoQueryResult,
} from "@jellyfin/sdk/lib/generated-client";
import {
  getSystemApi,
  getLibraryApi,
  getItemsApi,
  getImageApi,
} from "@jellyfin/sdk/lib/utils/api";
import { config } from "../../config";
import logger from "../../logger";

class JellyfinClient {
  private jellyfin: Jellyfin;
  private api: ReturnType<Jellyfin["createApi"]>;

  constructor() {
    this.jellyfin = new Jellyfin({
      clientInfo: {
        name: "Blitzcrank Discord Bot",
        version: "1.0.0",
      },
      deviceInfo: {
        name: "Blitzcrank Discord Bot",
        id: "blitzcrank-discord-bot",
      },
    });

    this.api = this.jellyfin.createApi(config.jellyfin.url);
    this.api.accessToken = config.jellyfin.apiKey;
  }

  async jellyfinStatus(): Promise<boolean> {
    try {
      const response = await getSystemApi(this.api).getPublicSystemInfo();
      return true;
    } catch (error) {
      logger.error("Error testing Jellyfin API:", error);
      return false;
    }
  }

  async getAllLibraries(
    ignorePlaylists: boolean = true
  ): Promise<BaseItemDto[]> {
    const response = await getLibraryApi(this.api).getMediaFolders();
    const libraries = response.data.Items ?? [];

    if (ignorePlaylists) {
      return libraries.filter(
        (library) => library.CollectionType !== "playlists"
      );
    }

    return libraries;
  }

  async getLibraryItemCount(
    libraryId: string,
    recursive: boolean = true
  ): Promise<number> {
    const response = await getItemsApi(this.api).getItems({
      parentId: libraryId,
      recursive: recursive,
    });
    return response.data.TotalRecordCount ?? 0;
  }

  async getLibraryItems(
    libraryId: string,
    recursive: boolean = true
  ): Promise<BaseItemDto[]> {
    const response = await getItemsApi(this.api).getItems({
      parentId: libraryId,
      recursive: recursive,
    });
    return response.data.Items ?? [];
  }

  async getItemDetails(itemId: string): Promise<BaseItemDto | null> {
    try {
      const response = await getItemsApi(this.api).getItems({
        ids: [itemId],
        recursive: true,
        fields: ["Overview", "Genres", "Studios", "ExternalUrls"],
      });
      return response.data.Items?.[0] ?? null;
    } catch (error) {
      logger.error(`Error fetching item details for ${itemId}:`, error);
      return null;
    }
  }

  async getItemImageUrl(
    itemId: string,
    imageType: ImageType = ImageType.Primary
  ): Promise<string> {
    try {
      const itemResponse = await getItemsApi(this.api).getItems({
        ids: [itemId],
        recursive: true,
        fields: [],
      });
      const item = itemResponse.data.Items?.[0];
      if (!item) {
        logger.warn(`Item not found for itemId: ${itemId}`);
        return "";
      }

      const image = item.ImageTags?.[imageType];
      if (!image) {
        logger.warn(
          `No image of type ${imageType} found for itemId: ${itemId}`
        );
        return "";
      }

      const imageUrl = `${config.jellyfin.url}/Items/${itemId}/Images/${ImageType[imageType]}?quality=60`;

      return imageUrl;
    } catch (error) {
      logger.error(
        `Error fetching image URL for itemId: ${itemId}, imageType: ${imageType}:`,
        error
      );
      return "";
    }
  }

  async getAllItems(): Promise<BaseItemDto[]> {
    try {
      const items = await getItemsApi(this.api).getItems({
        sortBy: ["Name"],
        sortOrder: ["Ascending"],
        recursive: true,
        includeItemTypes: ["Movie", "Series"],
        fields: ["Overview", "Genres", "Studios", "Tags"],
      });
      return items.data.Items || [];
    } catch (error) {
      console.error("Error fetching all items:", error);
      return [];
    }
  }
}

export const jellyfinClient = new JellyfinClient();
