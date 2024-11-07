import sharp from "sharp";

export interface SlicedImage {
  parts: EmoteImage[];
  columns: number;
}

export interface EmoteImage {
  image: Buffer;
  width: number;
  height: number;
}

export async function getEmoteImage(emoteId: string): Promise<EmoteImage> {
  const cdnBaseUrl = "https://cdn.7tv.app/emotes/";
  const cdnUrl = `${cdnBaseUrl}${emoteId}/2x.png`;

  const response = await fetch(cdnUrl);
  const buffer = await response.arrayBuffer();
  const metadata = await sharp(buffer).metadata();

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
