import { nowIso, type MemoryFrontmatter, type SkillFrontmatter, type SkillUsageRecord } from "@samurai-agent/core-schemas";
import type { MemoryIndexTable, SkillIndexTable, SkillUsageTable } from "../kernel/workspace-db-schema";
import type { SkillWithFilePath } from "../workspace-store-contracts";
import { parse, stringify } from "./serialization";
import { buildSkillIndexEntry } from "./workspace-file-codecs";
import { usageScopeIndexColumns } from "./usage-scope";
import { withUsageScope } from "./usage-scope";

export function memoryToRow(frontmatter: MemoryFrontmatter, filePath: string): MemoryIndexTable {
  return {
    id: frontmatter.id,
    state: frontmatter.state,
    topic: frontmatter.topic,
    source: frontmatter.source,
    source_locale: frontmatter.source_locale,
    content_locale: frontmatter.content_locale,
    source_kind: frontmatter.source_kind,
    instruction_authority: frontmatter.instruction_authority,
    ...usageScopeIndexColumns(frontmatter.usage_scope),
    file_path: filePath,
    frontmatter_json: stringify(frontmatter),
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at
  };
}

export function skillToRow(frontmatter: SkillFrontmatter, filePath: string): SkillIndexTable {
  const now = nowIso();
  return {
    id: frontmatter.id,
    state: frontmatter.state,
    title: frontmatter.title,
    description: frontmatter.description,
    tags_json: stringify(frontmatter.tags),
    required_capabilities_json: stringify(frontmatter.required_capabilities),
    ...usageScopeIndexColumns(frontmatter.usage_scope),
    file_path: filePath,
    frontmatter_json: stringify(frontmatter),
    created_at: now,
    updated_at: frontmatter.last_reviewed_at ?? now
  };
}

export function skillFromRow(row: SkillIndexTable): SkillWithFilePath {
  return {
    ...buildSkillIndexEntry(withUsageScope(parse(row.frontmatter_json))),
    file_path: row.file_path
  };
}

export function skillUsageFromRow(row: SkillUsageTable): SkillUsageRecord {
  return {
    skill_id: row.skill_id,
    use_count: row.use_count,
    last_used_at: row.last_used_at ?? undefined,
    last_run_id: row.last_run_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
