import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const supportedLocales = ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"];
const root = path.dirname(fileURLToPath(import.meta.url));
const localeDir = path.resolve(root, "../locales");

const messages = Object.fromEntries(
  await Promise.all(
    supportedLocales.map(async (locale) => [
      locale,
      JSON.parse(await readFile(path.join(localeDir, `${locale}.json`), "utf8"))
    ])
  )
);

const canonicalKeys = Object.keys(messages.ja).sort();
const failures = [];

for (const locale of supportedLocales) {
  const keys = Object.keys(messages[locale]).sort();
  const missing = canonicalKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !canonicalKeys.includes(key));
  const empty = keys.filter((key) => String(messages[locale][key] ?? "").trim().length === 0);

  if (missing.length > 0 || extra.length > 0 || empty.length > 0) {
    failures.push(`${locale}: missing=${missing.join(",")} extra=${extra.join(",")} empty=${empty.join(",")}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Locale key check failed\n${failures.join("\n")}`);
}

console.log("locale key check passed");
