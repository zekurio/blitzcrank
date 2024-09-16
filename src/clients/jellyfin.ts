import { Jellyfin } from "@jellyfin/sdk";
import type {
  BaseItemDto,
  BaseItemDtoQueryResult,
  ImageType,
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
      fields: ["Overview", "Genres", "Studios", "Tags", "SeriesPrimaryImage"],
    });
    return response.data.Items?.[0] ?? null;
  } catch (error) {
    logger.error(`Error fetching item details for ${itemId}:`, error);
    return null;
  }
}

export async function getItemImageUrl(itemId: string): Promise<string> {
  const response = await getImageApi(api).getItemImage({
    itemId: itemId,
    imageType: "Primary",
  });

  return response.data.url;
}
