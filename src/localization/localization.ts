import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const localizations: { [key: string]: any } = {};

// Load all localization files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localizationDir = path.join(__dirname, "..", "localization", "strings");

fs.readdirSync(localizationDir).forEach((file) => {
  if (file.endsWith(".json")) {
    const langCode = path.basename(file, ".json");
    const content = fs.readFileSync(path.join(localizationDir, file), "utf-8");
    localizations[langCode] = JSON.parse(content);
  }
});

export function getLocalization(
  key: string,
  lang: string = "en",
  replacements?: Record<string, string>
): string {
  const keys = key.split(".");
  let current = localizations[lang] || localizations["en"];
  for (const k of keys) {
    if (current[k] === undefined) {
      return key;
    }
    current = current[k];
  }

  if (typeof current !== "string") {
    return key;
  }

  if (replacements) {
    return current.replace(
      /\{(\w+)\}/g,
      (_, key) => replacements[key] || `{${key}}`
    );
  }

  return current;
}
