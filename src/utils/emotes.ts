import sharp from "sharp";
import logger from "../logger";

export interface SlicedImage {
  parts: EmoteImage[];
  columns: number;
}

export interface EmoteImage {
  image: Buffer;
  width: number;
  height: number;
}

export async function getEmoteImage(emoteUrl: string): Promise<EmoteImage> {
  // extract the emote id from the url, e.g https://7tv.app/emotes/01F6MA6Y100002B6P5MWZ5D916
  const emoteId = emoteUrl.split("/").pop();

  const cdnBaseUrl = "https://cdn.7tv.app/emote/";
  const cdnUrl = `${cdnBaseUrl}${emoteId}/2x.webp`;

  logger.debug(`Fetching emote image from ${cdnUrl}`);

  const response = await fetch(cdnUrl);
  const buffer = await response.arrayBuffer();
  const metadata = await sharp(Buffer.from(buffer)).metadata();

  return {
    image: Buffer.from(buffer),
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
}

export async function sliceWideImage(
  imageBuffer: Buffer
): Promise<SlicedImage> {
  // Load and get metadata of image
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not get image dimensions");
  }

  // Calculate how many 64px columns we need
  const columns = Math.ceil(metadata.width / 64);
  const parts: EmoteImage[] = [];

  const totalWidth = metadata.width;
  const remainingWidth = totalWidth - columns * 64;
  const edgeColumnWidth = 64 + Math.floor(remainingWidth / 2);

  // Slice the image into 64x64 parts
  for (let i = 0; i < columns; i++) {
    let extractWidth = 64;
    let extractLeft = i * 64;

    if (columns > 1) {
      if (i === 0) {
        // First column gets less width if needed
        extractWidth = Math.min(64, edgeColumnWidth);
      } else if (i === columns - 1) {
        // Last column gets the remaining width
        extractWidth = Math.min(64, totalWidth - extractLeft);
        extractLeft = totalWidth - extractWidth;
      }
    }

    const partBuffer = await image
      .extract({
        left: extractLeft,
        top: 0,
        width: extractWidth,
        height: metadata.height,
      })
      .resize(64, 64, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();

    parts.push({
      image: partBuffer,
      width: 64,
      height: 64,
    });
  }

  return {
    parts,
    columns,
  };
}
