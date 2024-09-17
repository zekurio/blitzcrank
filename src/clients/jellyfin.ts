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
import { config } from "../config";
import logger from "../logger";

const jellyfin = new Jellyfin({
  clientInfo: {
    name: "Blitzcrank Discord Bot",
    version: "1.0.0",
  },
  deviceInfo: {
    name: "Node.js Bot",
    id: "blitzcrank-discord-bot",
  },
});

const api = jellyfin.createApi(config.jellyfin.url);
api.accessToken = config.jellyfin.apiKey;

export async function jellyfinStatus(): Promise<boolean> {
  try {
    const response = await getSystemApi(api).getPublicSystemInfo();
    logger.debug("Jellyfin API test successful");
    return true;
  } catch (error) {
    logger.error("Error testing Jellyfin API:", error);
    return false;
  }
}

export async function getAllLibraries(
  ignorePlaylists: boolean = true
): Promise<BaseItemDto[]> {
  const response = await getLibraryApi(api).getMediaFolders();
  const libraries = response.data.Items ?? [];

  if (ignorePlaylists) {
    return libraries.filter(
      (library) => library.CollectionType !== "playlists"
    );
  }

  return libraries;
}

export async function getLibraryItemCount(libraryId: string): Promise<number> {
  const response = await getItemsApi(api).getItems({
    parentId: libraryId,
    recursive: true,
  });
  return response.data.TotalRecordCount ?? 0;
}

export async function getLibraryItems(
  libraryId: string,
  recursive: boolean = true
): Promise<BaseItemDto[]> {
  const response = await getItemsApi(api).getItems({
    parentId: libraryId,
    recursive: recursive,
  });
  return response.data.Items ?? [];
}

export async function getItemDetails(
  itemId: string
): Promise<BaseItemDto | null> {
  try {
    const response = await getItemsApi(api).getItems({
      ids: [itemId],
      recursive: true,
      fields: ["Overview", "Genres", "Studios", "Tags"],
    });
    return response.data.Items?.[0] ?? null;
  } catch (error) {
    logger.error(`Error fetching item details for ${itemId}:`, error);
    return null;
  }
}

export async function getItemImageUrl(
  itemId: string,
  imageType: ImageType = ImageType.Primary
): Promise<string> {
  try {
    const itemResponse = await getItemsApi(api).getItems({
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
      logger.warn(`No image of type ${imageType} found for itemId: ${itemId}`);
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
