import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MemoryFrontmatterSchema, SkillFrontmatterSchema, WikiFrontmatterSchema, type MemoryFrontmatter, type SkillFrontmatter, type WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { SkillIndexEntry } from "../workspace-store-contracts";

export function renderFrontmatter(frontmatter: object): string {
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---"
  ].join("\n");
}

export async function readWorkspaceText(rootDir: string, filePath: string): Promise<string> {
  return readFile(path.join(rootDir, filePath), "utf8").catch(() => "");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listWikiMarkdownFiles(rootDir: string): Promise<string[]> {
  const wikiRoot = path.join(rootDir, "wiki", "pages");
  if (!await pathExists(wikiRoot)) {
    return [];
  }
  const files = await listRelativeFiles(wikiRoot);
  return files
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".md")
    .map((filePath) => path.join("wiki", "pages", filePath))
    .sort();
}

export async function listArtifactFiles(rootDir: string): Promise<string[]> {
  const artifactRoot = path.join(rootDir, "artifacts");
  if (!await pathExists(artifactRoot)) {
    return [];
  }
  const files = await listRelativeFiles(artifactRoot);
  return files
    .filter((filePath) => !filePath.endsWith(".DS_Store"))
    .map((filePath) => path.join("artifacts", filePath))
    .sort();
}

export async function listMemoryMarkdownFiles(rootDir: string): Promise<string[]> {
  const memoryRoot = path.join(rootDir, "memory");
  if (!await pathExists(memoryRoot)) {
    return [];
  }
  const files = await listRelativeFiles(memoryRoot);
  return files
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".md")
    .map((filePath) => path.join("memory", filePath))
    .sort();
}

export async function listSkillMarkdownFiles(rootDir: string): Promise<string[]> {
  const skillsRoot = path.join(rootDir, "skills");
  if (!await pathExists(skillsRoot)) {
    return [];
  }
  const files = await listRelativeFiles(skillsRoot);
  return files
    .filter((filePath) => {
      const parts = filePath.split(path.sep);
      return parts.length === 2 && parts[0] !== "support" && path.extname(filePath).toLowerCase() === ".md";
    })
    .map((filePath) => path.join("skills", filePath))
    .sort();
}

export async function listCollectionSchemaFiles(rootDir: string): Promise<string[]> {
  const collectionsRoot = path.join(rootDir, "collections");
  if (!await pathExists(collectionsRoot)) {
    return [];
  }
  const files = await listRelativeFiles(collectionsRoot);
  return files
    .filter((filePath) => path.basename(filePath) === "schema.json")
    .map((filePath) => path.join("collections", filePath))
    .sort();
}

export async function listCollectionRecordFiles(rootDir: string): Promise<string[]> {
  const collectionsRoot = path.join(rootDir, "collections");
  if (!await pathExists(collectionsRoot)) {
    return [];
  }
  const files = await listRelativeFiles(collectionsRoot);
  return files
    .filter((filePath) => {
      const parts = filePath.split(path.sep);
      return parts.includes("records") && path.extname(filePath).toLowerCase() === ".json";
    })
    .map((filePath) => path.join("collections", filePath))
    .sort();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) {
    return raw;
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return raw;
  }
  const contentStart = raw.indexOf("\n", end + 4);
  return contentStart === -1 ? "" : raw.slice(contentStart + 1);
}

export function parseMemoryMarkdownLocal(markdown: string): { frontmatter: MemoryFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("memory_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("memory_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: MemoryFrontmatterSchema.parse(parseRenderedFrontmatter(rawFrontmatter)),
    content
  };
}

export function parseSkillMarkdownLocal(markdown: string): { frontmatter: SkillFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("skill_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("skill_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: SkillFrontmatterSchema.parse(JSON.parse(rawFrontmatter)),
    content
  };
}

export function parseWikiMarkdownLocal(markdown: string): { frontmatter: WikiFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("wiki_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("wiki_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: WikiFrontmatterSchema.parse(parseRenderedFrontmatter(rawFrontmatter)),
    content
  };
}

export function parseRenderedFrontmatter(rawFrontmatter: string): Record<string, unknown> {
  const entries = rawFrontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        throw new Error("wiki_frontmatter_invalid_line");
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      return [key, JSON.parse(value)] as const;
    });
  return Object.fromEntries(entries);
}

export function assertMemoryPathMatchesFrontmatter(filePath: string, frontmatter: MemoryFrontmatter): void {
  const expected = path.join("memory", frontmatter.state, `${frontmatter.id}.md`);
  if (filePath !== expected) {
    throw new Error(`memory_frontmatter_path_mismatch:${expected}`);
  }
}

export function assertSkillPathMatchesFrontmatter(filePath: string, frontmatter: SkillFrontmatter): void {
  const expected = path.join("skills", frontmatter.state, `${frontmatter.id}.md`);
  if (filePath !== expected) {
    throw new Error(`skill_frontmatter_path_mismatch:${expected}`);
  }
}

export function buildSkillIndexEntry(frontmatter: SkillFrontmatter): SkillIndexEntry {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    description: frontmatter.description,
    tags: frontmatter.tags,
    state: frontmatter.state,
    allowed_scopes: frontmatter.allowed_scopes,
    required_capabilities: frontmatter.required_capabilities,
    owner_pinned: frontmatter.owner_pinned,
    frontmatter
  };
}

export async function listRelativeFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) return listRelativeFiles(rootDir, absolutePath);
    if (!entry.isFile()) return [];
    return [path.relative(rootDir, absolutePath)];
  }));
  return nested.flat();
}

export function normalizeSkillSupportPath(inputPath: string): string {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("skill_support_path_invalid");
  }
  return normalized;
}
