import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProfileRecordSchema, type ProfileRecord } from "@samurai-agent/core-schemas";

export interface ProfileExportManifest {
  schema_version: 1;
  profile: ProfileRecord;
  secret_material_included: false;
  file_hashes: Record<string, string>;
}

export class ProfileRegistry {
  constructor(readonly rootDir: string) {}

  async create(input: { id: string; name: string; secretRefIds?: string[] }): Promise<ProfileRecord> {
    const now = new Date().toISOString();
    const workspaceRoot = path.join(this.rootDir, "profiles", input.id, "workspace");
    const record = ProfileRecordSchema.parse({ id: input.id, name: input.name, workspace_root: workspaceRoot, user_model_file: "USER_PROFILE.json", secret_ref_ids: input.secretRefIds ?? [], created_at: now, updated_at: now });
    const profileDir = this.profileDir(record.id);
    if (await this.get(record.id)) throw new Error(`profile_exists:${record.id}`);
    await mkdir(profileDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: false });
    await this.writeRecord(record);
    await writeFile(path.join(workspaceRoot, record.user_model_file), `${JSON.stringify({ version: 1, facts: [] }, null, 2)}\n`, { flag: "wx" });
    return record;
  }

  async list(): Promise<ProfileRecord[]> {
    const profilesRoot = path.join(this.rootDir, "profiles");
    const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
    const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name)));
    return records.filter((record): record is ProfileRecord => Boolean(record)).sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<ProfileRecord | undefined> {
    const raw = await readFile(path.join(this.profileDir(id), "profile.json"), "utf8").catch(() => undefined);
    return raw ? ProfileRecordSchema.parse(JSON.parse(raw)) : undefined;
  }

  async switch(id: string): Promise<ProfileRecord> {
    const profile = await this.get(id);
    if (!profile) throw new Error(`profile_not_found:${id}`);
    await mkdir(this.rootDir, { recursive: true });
    await atomicJsonWrite(path.join(this.rootDir, "active-profile.json"), { profile_id: id, updated_at: new Date().toISOString() });
    return profile;
  }

  async active(): Promise<ProfileRecord | undefined> {
    const raw = await readFile(path.join(this.rootDir, "active-profile.json"), "utf8").catch(() => undefined);
    if (!raw) return undefined;
    const id = (JSON.parse(raw) as { profile_id?: unknown }).profile_id;
    return typeof id === "string" ? this.get(id) : undefined;
  }

  async clone(sourceId: string, input: { id: string; name: string; includeSecretRefs?: boolean }): Promise<ProfileRecord> {
    const source = await this.get(sourceId);
    if (!source) throw new Error(`profile_not_found:${sourceId}`);
    const target = await this.create({ id: input.id, name: input.name, secretRefIds: input.includeSecretRefs ? source.secret_ref_ids : [] });
    await rm(target.workspace_root, { recursive: true, force: true });
    await cp(source.workspace_root, target.workspace_root, { recursive: true, errorOnExist: true });
    return target;
  }

  async export(id: string, destination: string): Promise<{ export_root: string; manifest: ProfileExportManifest }> {
    const profile = await this.get(id);
    if (!profile) throw new Error(`profile_not_found:${id}`);
    const exportRoot = path.join(destination, `profile-${id}`);
    await mkdir(exportRoot, { recursive: false });
    await cp(profile.workspace_root, path.join(exportRoot, "workspace"), { recursive: true });
    const fileHashes = await hashTree(path.join(exportRoot, "workspace"));
    const manifest: ProfileExportManifest = { schema_version: 1, profile: { ...profile, workspace_root: "workspace", secret_ref_ids: [...profile.secret_ref_ids] }, secret_material_included: false, file_hashes: fileHashes };
    await atomicJsonWrite(path.join(exportRoot, "manifest.json"), manifest);
    return { export_root: exportRoot, manifest };
  }

  async inspectImport(exportRoot: string, targetId?: string): Promise<{ valid: boolean; conflicts: string[]; profile: ProfileRecord; file_count: number }> {
    const manifest = JSON.parse(await readFile(path.join(exportRoot, "manifest.json"), "utf8")) as ProfileExportManifest;
    if (manifest.schema_version !== 1 || manifest.secret_material_included !== false) throw new Error("profile_export_manifest_invalid");
    const actual = await hashTree(path.join(exportRoot, "workspace"));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.file_hashes)) throw new Error("profile_export_hash_mismatch");
    const id = targetId ?? manifest.profile.id;
    const conflicts = (await this.get(id)) ? [`profile_exists:${id}`] : [];
    return { valid: conflicts.length === 0, conflicts, profile: ProfileRecordSchema.parse({ ...manifest.profile, id, workspace_root: path.join(this.rootDir, "profiles", id, "workspace") }), file_count: Object.keys(actual).length };
  }

  async import(exportRoot: string, input: { id?: string; name?: string }): Promise<ProfileRecord> {
    const inspection = await this.inspectImport(exportRoot, input.id);
    if (!inspection.valid) throw new Error(inspection.conflicts.join(","));
    const profile = ProfileRecordSchema.parse({ ...inspection.profile, name: input.name ?? inspection.profile.name, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await mkdir(this.profileDir(profile.id), { recursive: false });
    try {
      await cp(path.join(exportRoot, "workspace"), profile.workspace_root, { recursive: true, errorOnExist: true });
      await this.writeRecord(profile);
      return profile;
    } catch (error) {
      await rm(this.profileDir(profile.id), { recursive: true, force: true });
      throw error;
    }
  }

  private profileDir(id: string): string { return path.join(this.rootDir, "profiles", id); }
  private async writeRecord(record: ProfileRecord): Promise<void> { await atomicJsonWrite(path.join(this.profileDir(record.id), "profile.json"), record); }
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true }); const pending = `${filePath}.pending`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`); await rename(pending, filePath);
}
async function hashTree(root: string): Promise<Record<string, string>> {
  const files: string[] = [];
  const walk = async (directory: string) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name); if (entry.isDirectory()) await walk(absolute); else if (entry.isFile()) files.push(path.relative(root, absolute)); } };
  if ((await stat(root).catch(() => undefined))?.isDirectory()) await walk(root);
  const entries = await Promise.all(files.sort().map(async (file) => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")] as const));
  return Object.fromEntries(entries);
}
