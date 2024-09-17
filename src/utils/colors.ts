import axios from "axios";
import sharp from "sharp";
import logger from "../logger";

type HexColor = number;

export async function getDominantColor(imageUrl: string): Promise<HexColor> {
  try {
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data, "binary");

    const image = sharp(buffer);
    const { data, info } = await image
      .resize(100, 100, { fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const colorCounts: Map<number, number> = new Map();
    for (let i = 0; i < data.length; i += 3) {
      const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
    }

    let dominantColor = 0;
    let maxCount = 0;
    for (const [color, count] of colorCounts.entries()) {
      if (count > maxCount) {
        dominantColor = color;
        maxCount = count;
      }
    }

    return dominantColor;
  } catch (error) {
    logger.error("Error processing image:", error);
    throw error;
  }
}
