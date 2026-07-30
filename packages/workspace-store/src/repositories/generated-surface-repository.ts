import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nowIso, type GeneratedSurfaceDefinition, type GeneratedSurfaceRevisionRecord, type SurfaceInteractionRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { generatedSurfaceRevisionToRow, generatedSurfaceToRow, surfaceInteractionToRow } from "./generated-surface-row-codecs";
import { parse, stringify } from "./serialization";

/** Generated Surface versions and interaction history. */
export class GeneratedSurfaceRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>, private readonly rootDir: string) {}

  async saveGeneratedSurfaceRevision(input: {
    definition: GeneratedSurfaceDefinition;
    revision: GeneratedSurfaceRevisionRecord;
    html: string;
    css?: string;
    script?: string;
    assets?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
  }): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord }> {
    const assetFiles = (input.assets ?? []).map((asset) => {
      const ref = input.revision.asset_refs.find((candidate) => candidate.label === asset.path);
      if (!ref) throw new Error(`generated_surface_asset_ref_missing:${asset.path}`);
      return { ref, content: asset.encoding === "base64" ? Buffer.from(asset.content, "base64") : asset.content };
    });
    const files = [
      { ref: input.revision.html_ref, content: input.html },
      ...(input.revision.css_ref ? [{ ref: input.revision.css_ref, content: input.css ?? "" }] : []),
      ...(input.revision.script_ref ? [{ ref: input.revision.script_ref, content: input.script ?? "" }] : []),
      ...assetFiles
    ];
    const absoluteFiles = files.map((file) => {
      const absolute = path.resolve(this.rootDir, file.ref.uri);
      const root = `${path.resolve(this.rootDir)}${path.sep}`;
      if (!absolute.startsWith(root)) throw new Error("generated_surface_file_path_invalid");
      return { ...file, absolute };
    });
    for (const file of absoluteFiles) {
      const absolute = file.absolute;
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, { flag: "wx" });
    }
    try {
      await this.db.transaction().execute(async (transaction) => {
        await transaction.insertInto("generated_surfaces").values(generatedSurfaceToRow(input.definition)).onConflict((conflict) => conflict.column("id").doUpdateSet(generatedSurfaceToRow(input.definition))).execute();
        await transaction.insertInto("generated_surface_revisions").values(generatedSurfaceRevisionToRow(input.revision)).execute();
      });
    } catch (error) {
      await Promise.all(absoluteFiles.map((file) => rm(file.absolute, { force: true })));
      throw error;
    }
    return { definition: input.definition, revision: input.revision };
  }

  async getGeneratedSurface(id: string): Promise<GeneratedSurfaceDefinition | undefined> {
    const row = await this.db.selectFrom("generated_surfaces").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? parse<GeneratedSurfaceDefinition>(row.definition_json) : undefined;
  }

  async listGeneratedSurfaces(sessionId?: string): Promise<GeneratedSurfaceDefinition[]> {
    let query = this.db.selectFrom("generated_surfaces").selectAll();
    if (sessionId) query = query.where("session_id", "=", sessionId);
    return (await query.orderBy("updated_at", "desc").execute()).map((row) => parse<GeneratedSurfaceDefinition>(row.definition_json));
  }

  async getGeneratedSurfaceRevision(id: string): Promise<GeneratedSurfaceRevisionRecord | undefined> {
    const row = await this.db.selectFrom("generated_surface_revisions").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? parse<GeneratedSurfaceRevisionRecord>(row.revision_json) : undefined;
  }

  async listGeneratedSurfaceRevisions(surfaceId: string): Promise<GeneratedSurfaceRevisionRecord[]> {
    return (await this.db.selectFrom("generated_surface_revisions").selectAll().where("surface_id", "=", surfaceId).orderBy("revision", "asc").execute()).map((row) => parse<GeneratedSurfaceRevisionRecord>(row.revision_json));
  }

  async readGeneratedSurfaceBundle(revisionId: string): Promise<{ html: string; css?: string; script?: string } | undefined> {
    const revision = await this.getGeneratedSurfaceRevision(revisionId);
    if (!revision) return undefined;
    return {
      html: await readFile(path.join(this.rootDir, revision.html_ref.uri), "utf8"),
      ...(revision.css_ref ? { css: await readFile(path.join(this.rootDir, revision.css_ref.uri), "utf8") } : {}),
      ...(revision.script_ref ? { script: await readFile(path.join(this.rootDir, revision.script_ref.uri), "utf8") } : {})
    };
  }

  async readGeneratedSurfaceAssets(revisionId: string): Promise<Array<{ path: string; content: Buffer }>> {
    const revision = await this.getGeneratedSurfaceRevision(revisionId);
    if (!revision) return [];
    const root = `${path.resolve(this.rootDir)}${path.sep}`;
    const assets: Array<{ path: string; content: Buffer }> = [];
    for (const ref of revision.asset_refs ?? []) {
      const absolute = path.resolve(this.rootDir, ref.uri);
      if (!absolute.startsWith(root)) continue;
      const assetPath = ref.label ?? path.basename(ref.uri);
      if (!assetPath || assetPath.includes("..")) continue;
      try {
        assets.push({ path: assetPath, content: await readFile(absolute) });
      } catch {
        // A missing optional asset does not make the HTML revision unreadable.
      }
    }
    return assets;
  }

  async updateGeneratedSurfaceState(id: string, state: GeneratedSurfaceDefinition["state"], updatedAt = nowIso()): Promise<GeneratedSurfaceDefinition | undefined> {
    const current = await this.getGeneratedSurface(id);
    if (!current) return undefined;
    const next = { ...current, state, updated_at: updatedAt };
    await this.db.updateTable("generated_surfaces").set(generatedSurfaceToRow(next)).where("id", "=", id).execute();
    return next;
  }

  async saveSurfaceInteraction(record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord> {
    await this.db.insertInto("surface_interactions").values(surfaceInteractionToRow(record)).execute();
    return record;
  }

  async listSurfaceInteractions(surfaceId: string): Promise<SurfaceInteractionRecord[]> {
    return (await this.db.selectFrom("surface_interactions").selectAll().where("surface_id", "=", surfaceId).orderBy("created_at", "asc").execute()).map((row) => parse<SurfaceInteractionRecord>(row.interaction_json));
  }

}
