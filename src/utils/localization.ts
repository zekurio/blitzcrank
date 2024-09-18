import fs from "fs";
import path from "path";

const localizations: { [key: string]: any } = {};

// Load all localization files
const localizationDir = path.join(__dirname, "..", "localizations");
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
  let current = localizations[lang] || localizations["en"]; // Fallback to English if the language is not found
  for (const k of keys) {
    if (current[k] === undefined) {
      return key; // Return the key if the localization is not found
    }
    current = current[k];
  }

  if (typeof current !== "string") {
    return key; // Return the key if the final value is not a string
  }

  // Replace placeholders with provided values
  if (replacements) {
    return current.replace(
      /\{(\w+)\}/g,
      (_, key) => replacements[key] || `{${key}}`
    );
  }

  return current;
}
