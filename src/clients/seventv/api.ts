import type { AxiosInstance } from "axios";
import axios from "axios";
import type { Emote, EmoteFile } from "./models";

class SeventvClient {
  private axios: AxiosInstance;

  constructor() {
    this.axios = axios.create({
      baseURL: "https://7tv.io/api/v3",
    });
  }

  async getEmoteFromUrl(url: string) {
    const emoteId = url.split("/").pop();
    if (!emoteId) {
      throw new Error("Could not get emote id from url");
    }
    return this.getEmote(emoteId);
  }

  async getEmote(emoteId: string): Promise<Emote> {
    const response = await this.axios.get(`/emotes/${emoteId}`);
    return response.data;
  }

  getEmoteCdnUrl(emoteId: string, size: number = 2): string {
    const supportedSizes = [1, 2, 3];
    const sizeStr = supportedSizes.includes(size) ? `${size}x` : "2x";
    return `https://cdn.7tv.app/emote/${emoteId}/${sizeStr}.webp`;
  }

  async downloadEmoteImage(emoteId: string, size: number = 2): Promise<Buffer> {
    const url = this.getEmoteCdnUrl(emoteId, size);
    const response = await this.axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
  }
}

export const seventvClient = new SeventvClient();
