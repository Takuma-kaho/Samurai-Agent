export function normalizeBackupId(id: string): string {
  const trimmed = id.trim();
  if (!/^backup_[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error("workspace_backup_id_invalid");
  return trimmed;
}
