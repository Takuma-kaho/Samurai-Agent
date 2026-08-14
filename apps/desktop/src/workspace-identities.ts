import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceIdentityStore {
  save(accountId: string, privateKey: string): Promise<string>;
  load(accountId: string): Promise<string | undefined>;
  has(accountId: string): Promise<boolean>;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface StoredIdentities {
  version: 1;
  encryptedPrivateKeys: Record<string, string>;
}

/**
 * Electron safeStorage uses the operating system's protected credential store
 * (Keychain on macOS). The connection registry keeps only the opaque ref.
 */
export function createWorkspaceIdentityStore(filePath: string, safeStorage: SafeStorageLike): WorkspaceIdentityStore {
  return {
    async save(accountId, privateKey) {
      assertAccountId(accountId);
      if (!safeStorage.isEncryptionAvailable()) throw new Error("workspace_identity_secure_storage_unavailable");
      const normalized = privateKey.trim();
      if (!normalized || normalized.length > 20_000) throw new Error("workspace_identity_private_key_invalid");
      const stored = await loadStoredIdentities(filePath);
      stored.encryptedPrivateKeys[accountId] = safeStorage.encryptString(normalized).toString("base64");
      await saveStoredIdentities(filePath, stored);
      return `electron-safe-storage://workspace-account/${accountId}`;
    },
    async load(accountId) {
      assertAccountId(accountId);
      if (!safeStorage.isEncryptionAvailable()) throw new Error("workspace_identity_secure_storage_unavailable");
      const stored = await loadStoredIdentities(filePath);
      const encrypted = stored.encryptedPrivateKeys[accountId];
      if (!encrypted) return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      } catch {
        throw new Error("workspace_identity_decryption_failed");
      }
    },
    async has(accountId) {
      assertAccountId(accountId);
      if (!safeStorage.isEncryptionAvailable()) return false;
      const stored = await loadStoredIdentities(filePath);
      return Boolean(stored.encryptedPrivateKeys[accountId]);
    }
  };
}

async function loadStoredIdentities(filePath: string): Promise<StoredIdentities> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("workspace_identity_store_invalid");
    const value = parsed as Partial<StoredIdentities>;
    if (value.version !== 1 || !value.encryptedPrivateKeys || typeof value.encryptedPrivateKeys !== "object" || Array.isArray(value.encryptedPrivateKeys)) {
      throw new Error("workspace_identity_store_invalid");
    }
    for (const [accountId, encrypted] of Object.entries(value.encryptedPrivateKeys)) {
      assertAccountId(accountId);
      if (typeof encrypted !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new Error("workspace_identity_store_invalid");
    }
    return { version: 1, encryptedPrivateKeys: { ...value.encryptedPrivateKeys } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, encryptedPrivateKeys: {} };
    throw error;
  }
}

async function saveStoredIdentities(filePath: string, stored: StoredIdentities): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

function assertAccountId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("workspace_identity_account_id_invalid");
}
