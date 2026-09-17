import { supportedLocales, type SupportedLocale } from "@samurai-agent/core-schemas";

/** The database and store are deliberately separate from credentials and theme storage. */
export const nativeAccountPreferencesDatabaseName = "samurai-account-preferences-v1";
export const nativeAccountPreferencesDatabaseVersion = 1;
export const nativeAccountPreferencesStoreName = "preferences";
export const nativeAccountPreferencesSchemaVersion = 1 as const;

const nativeAccountPreferenceKeys = [
  "schema_version",
  "revision",
  "display_name",
  "output_locale",
  "instructions",
  "updated_at"
] as const;

const nativeAccountPreferenceInputKeys = ["display_name", "output_locale", "instructions"] as const;
const supportedLocaleSet = new Set<string>(supportedLocales);

export type NativeAccountPreferences = {
  schema_version: typeof nativeAccountPreferencesSchemaVersion;
  /** The initial, locally-created default uses revision 0. */
  revision: number;
  display_name: string;
  output_locale: SupportedLocale | null;
  instructions: string;
  updated_at: string;
};

export type NativeAccountPreferencesInput = Pick<
  NativeAccountPreferences,
  "display_name" | "output_locale" | "instructions"
>;

export type NativeAccountPreferencesErrorCode =
  | "personal_settings_account_id_invalid"
  | "personal_settings_input_invalid"
  | "personal_settings_schema_unsupported"
  | "personal_settings_record_invalid"
  | "personal_settings_not_initialized"
  | "personal_settings_conflict"
  | "personal_settings_storage_unavailable"
  | "personal_settings_storage_failed";

/**
 * Errors from this module are intentionally stable codes. Callers can map the
 * codes to localized UI text without displaying browser/IndexedDB internals.
 */
export class NativeAccountPreferencesError extends Error {
  readonly code: NativeAccountPreferencesErrorCode;

  constructor(code: NativeAccountPreferencesErrorCode, cause?: unknown) {
    super(code);
    this.name = "NativeAccountPreferencesError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Load the preferences for one Account. A missing record is initialized once
 * with the current registered display name; an existing record is never
 * replaced by defaults.
 */
export async function loadNativeAccountPreferences(
  accountId: string,
  registeredDisplayName: string
): Promise<NativeAccountPreferences> {
  const key = normalizeAccountId(accountId);
  const defaultRecord = createDefaultPreferences(registeredDisplayName);
  return withPreferencesTransaction(key, "readwrite", (store, setResult, fail) => {
    const request = store.get(key);
    request.onerror = (event) => {
      event.preventDefault();
      fail(request.error ?? new Error("native_account_preferences_read_failed"));
    };
    request.onsuccess = () => {
      try {
        if (request.result === undefined) {
          const put = store.put(defaultRecord, key);
          put.onerror = (event) => {
            event.preventDefault();
            fail(put.error ?? new Error("native_account_preferences_default_write_failed"));
          };
          setResult(defaultRecord);
          return;
        }
        setResult(parseStoredPreferences(request.result));
      } catch (error) {
        fail(error);
      }
    };
  });
}

/**
 * Replace the complete preference record after checking the expected revision
 * inside the same readwrite transaction. Account IDs are used only as the
 * IndexedDB key and are never copied into the stored value.
 */
export async function saveNativeAccountPreferences(
  accountId: string,
  expectedRevision: number,
  input: NativeAccountPreferencesInput
): Promise<NativeAccountPreferences> {
  const key = normalizeAccountId(accountId);
  const expected = normalizeExpectedRevision(expectedRevision);
  const nextInput = normalizeInput(input);
  return withPreferencesTransaction(key, "readwrite", (store, setResult, fail) => {
    const request = store.get(key);
    request.onerror = (event) => {
      event.preventDefault();
      fail(request.error ?? new Error("native_account_preferences_read_failed"));
    };
    request.onsuccess = () => {
      try {
        if (request.result === undefined) {
          fail(new NativeAccountPreferencesError("personal_settings_not_initialized"));
          return;
        }
        const current = parseStoredPreferences(request.result);
        if (current.revision !== expected) {
          fail(new NativeAccountPreferencesError("personal_settings_conflict"));
          return;
        }
        if (current.revision >= Number.MAX_SAFE_INTEGER) {
          fail(new NativeAccountPreferencesError("personal_settings_record_invalid"));
          return;
        }
        const next: NativeAccountPreferences = {
          schema_version: nativeAccountPreferencesSchemaVersion,
          revision: current.revision + 1,
          display_name: nextInput.display_name,
          output_locale: nextInput.output_locale,
          instructions: nextInput.instructions,
          updated_at: new Date().toISOString()
        };
        const put = store.put(next, key);
        put.onerror = (event) => {
          event.preventDefault();
          fail(put.error ?? new Error("native_account_preferences_write_failed"));
        };
        setResult(next);
      } catch (error) {
        fail(error);
      }
    };
  });
}

/** Convenience aliases matching the read/write terminology used by callers. */
export const readNativeAccountPreferences = loadNativeAccountPreferences;
export const writeNativeAccountPreferences = saveNativeAccountPreferences;

function createDefaultPreferences(registeredDisplayName: string): NativeAccountPreferences {
  return {
    schema_version: nativeAccountPreferencesSchemaVersion,
    revision: 0,
    display_name: normalizeDisplayName(registeredDisplayName),
    output_locale: null,
    instructions: "",
    updated_at: new Date().toISOString()
  };
}

function normalizeAccountId(value: string): string {
  if (typeof value !== "string") throw new NativeAccountPreferencesError("personal_settings_account_id_invalid");
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new NativeAccountPreferencesError("personal_settings_account_id_invalid");
  }
  return normalized;
}

function normalizeExpectedRevision(value: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NativeAccountPreferencesError("personal_settings_input_invalid");
  }
  return value;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new NativeAccountPreferencesError("personal_settings_input_invalid");
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new NativeAccountPreferencesError("personal_settings_input_invalid");
  }
  return normalized;
}

function normalizeOutputLocale(value: unknown): SupportedLocale | null {
  if (value === null) return null;
  if (typeof value === "string" && supportedLocaleSet.has(value)) return value as SupportedLocale;
  throw new NativeAccountPreferencesError("personal_settings_input_invalid");
}

function normalizeInstructions(value: unknown): string {
  if (typeof value !== "string" || value.length > 20_000) {
    throw new NativeAccountPreferencesError("personal_settings_input_invalid");
  }
  return value;
}

function normalizeInput(value: NativeAccountPreferencesInput): NativeAccountPreferencesInput {
  if (!isRecord(value) || !hasExactlyKeys(value, nativeAccountPreferenceInputKeys)) {
    throw new NativeAccountPreferencesError("personal_settings_input_invalid");
  }
  return {
    display_name: normalizeDisplayName(value.display_name),
    output_locale: normalizeOutputLocale(value.output_locale),
    instructions: normalizeInstructions(value.instructions)
  };
}

function parseStoredPreferences(value: unknown): NativeAccountPreferences {
  if (!isRecord(value)) throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  if (!Object.prototype.hasOwnProperty.call(value, "schema_version")) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  if (value.schema_version !== nativeAccountPreferencesSchemaVersion) {
    throw new NativeAccountPreferencesError("personal_settings_schema_unsupported");
  }
  if (!hasExactlyKeys(value, nativeAccountPreferenceKeys)) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  const revision = value.revision;
  const displayName = value.display_name;
  const outputLocale = value.output_locale;
  const instructions = value.instructions;
  const updatedAt = value.updated_at;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  if (typeof displayName !== "string"
    || displayName !== displayName.trim()
    || !displayName
    || displayName.length > 200) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  if (outputLocale !== null
    && (typeof outputLocale !== "string" || !supportedLocaleSet.has(outputLocale))) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  if (typeof instructions !== "string" || instructions.length > 20_000) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  if (revision === 0 && (outputLocale !== null || instructions !== "")) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  if (!isCanonicalTimestamp(updatedAt)) {
    throw new NativeAccountPreferencesError("personal_settings_record_invalid");
  }
  return {
    schema_version: nativeAccountPreferencesSchemaVersion,
    revision,
    display_name: displayName,
    output_locale: outputLocale as SupportedLocale | null,
    instructions,
    updated_at: updatedAt
  };
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactlyKeys<T extends readonly string[]>(value: Record<string, unknown>, keys: T): value is Record<T[number], unknown> {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function getIndexedDb(): IDBFactory {
  try {
    if (typeof window === "undefined" || !window.indexedDB) {
      throw new NativeAccountPreferencesError("personal_settings_storage_unavailable");
    }
    return window.indexedDB;
  } catch (error) {
    if (error instanceof NativeAccountPreferencesError) throw error;
    throw new NativeAccountPreferencesError("personal_settings_storage_unavailable", error);
  }
}

function openPreferencesDatabase(): Promise<IDBDatabase> {
  const indexedDb = getIndexedDb();
  return new Promise((resolve, reject) => {
    let upgradeError: NativeAccountPreferencesError | undefined;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDb.open(nativeAccountPreferencesDatabaseName, nativeAccountPreferencesDatabaseVersion);
    } catch (error) {
      reject(asStorageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      try {
        const database = request.result;
        if (!database.objectStoreNames.contains(nativeAccountPreferencesStoreName)) {
          database.createObjectStore(nativeAccountPreferencesStoreName);
        }
      } catch (error) {
        upgradeError = asStorageError(error);
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(nativeAccountPreferencesStoreName)) {
        database.close();
        reject(new NativeAccountPreferencesError("personal_settings_storage_failed"));
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      try {
        request.result?.close();
      } catch {
        // Closing an errored open request is best effort only.
      }
      reject(upgradeError ?? asStorageError(request.error));
    };
    request.onblocked = () => reject(new NativeAccountPreferencesError("personal_settings_storage_failed"));
  });
}

function withPreferencesTransaction<T>(
  accountId: string,
  mode: IDBTransactionMode,
  operation: (
    store: IDBObjectStore,
    setResult: (value: T) => void,
    fail: (error: unknown) => void
  ) => void
): Promise<T> {
  return openPreferencesDatabase().then((database) => new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    let operationError: unknown;
    let result: T | undefined;
    let resultSet = false;
    let settled = false;

    const close = () => {
      try {
        database.close();
      } catch {
        // Closing is best effort and must not hide the operation result.
      }
    };
    const settleFailure = (error: unknown) => {
      if (settled) return;
      settled = true;
      close();
      reject(asStorageError(error));
    };
    const settleSuccess = () => {
      if (settled) return;
      settled = true;
      close();
      if (operationError !== undefined) {
        reject(asStorageError(operationError));
      } else if (!resultSet) {
        reject(new NativeAccountPreferencesError("personal_settings_storage_failed"));
      } else {
        resolve(result as T);
      }
    };

    try {
      transaction = database.transaction(nativeAccountPreferencesStoreName, mode);
    } catch (error) {
      settleFailure(error);
      return;
    }
    transaction.oncomplete = settleSuccess;
    transaction.onerror = () => settleFailure(operationError ?? transaction.error ?? new Error("native_account_preferences_transaction_failed"));
    transaction.onabort = () => settleFailure(operationError ?? transaction.error ?? new Error("native_account_preferences_transaction_aborted"));

    const setResult = (value: T) => {
      result = value;
      resultSet = true;
    };
    const fail = (error: unknown) => {
      operationError ??= error;
      try {
        transaction.abort();
      } catch (abortError) {
        settleFailure(operationError ?? abortError);
      }
    };

    try {
      operation(transaction.objectStore(nativeAccountPreferencesStoreName), setResult, fail);
    } catch (error) {
      fail(error);
    }
  }));
}

function asStorageError(error: unknown): NativeAccountPreferencesError {
  if (error instanceof NativeAccountPreferencesError) return error;
  return new NativeAccountPreferencesError("personal_settings_storage_failed", error);
}
