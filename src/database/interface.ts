import type { StarboardConfig, StarboardEntry } from "./models";

export interface DatabaseInterface {
  connect(): Promise<void>;
}
