import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadNativeAccountPreferences,
  nativeAccountPreferencesDatabaseName,
  saveNativeAccountPreferences
} from "./native-account-preferences";

type FakeEventHandler = ((event: Event) => void) | null;

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: FakeEventHandler = null;
  onerror: FakeEventHandler = null;
  onupgradeneeded: FakeEventHandler = null;
  onblocked: FakeEventHandler = null;
  transaction: FakeTransaction | null = null;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: FakeEventHandler = null;
  onerror: FakeEventHandler = null;
  onabort: FakeEventHandler = null;
  private pending = 0;
  private aborted = false;

  constructor(private readonly database: FakeDatabase) {}

  objectStore(name: string): FakeObjectStore {
    const records = this.database.recordsByStore.get(name);
    if (!records) throw new Error(`missing_store:${name}`);
    return new FakeObjectStore(this, this.database, records);
  }

  schedule(action: () => void): void {
    this.pending += 1;
    queueMicrotask(() => {
      if (this.aborted) {
        this.pending -= 1;
        return;
      }
      try {
        action();
      } catch (error) {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.pending -= 1;
        this.abort();
        return;
      }
      this.pending -= 1;
      this.completeIfIdle();
    });
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.onabort?.(new Event("abort")));
  }

  private completeIfIdle(): void {
    if (this.aborted || this.pending !== 0) return;
    queueMicrotask(() => {
      if (!this.aborted && this.pending === 0) this.oncomplete?.(new Event("complete"));
    });
  }
}

class FakeObjectStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly database: FakeDatabase,
    private readonly records: Map<string, unknown>
  ) {}

  get(key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    this.transaction.schedule(() => {
      request.result = clone(this.records.get(key));
      request.onsuccess?.(new Event("success"));
    });
    return request;
  }

  put(value: unknown, key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    this.transaction.schedule(() => {
      if (this.database.failWrites) {
        request.error = new Error("quota");
        request.onerror?.(new Event("error"));
        return;
      }
      this.records.set(key, clone(value));
      request.result = key;
      request.onsuccess?.(new Event("success"));
    });
    return request;
  }
}

class FakeDatabase {
  readonly recordsByStore = new Map<string, Map<string, unknown>>();
  readonly objectStoreNames = { contains: (name: string) => this.recordsByStore.has(name) } as DOMStringList;
  failWrites = false;

  createObjectStore(name: string): FakeObjectStore {
    if (this.recordsByStore.has(name)) throw new Error(`store_exists:${name}`);
    const records = new Map<string, unknown>();
    this.recordsByStore.set(name, records);
    return new FakeObjectStore(new FakeTransaction(this), this, records);
  }

  transaction(name: string, _mode: IDBTransactionMode): FakeTransaction {
    if (!this.recordsByStore.has(name)) throw new Error(`missing_store:${name}`);
    return new FakeTransaction(this);
  }

  close(): void {}

  seed(key: string, value: unknown): void {
    const records = this.recordsByStore.get("preferences") ?? new Map<string, unknown>();
    this.recordsByStore.set("preferences", records);
    records.set(key, clone(value));
  }

  read(key: string): unknown {
    return clone(this.recordsByStore.get("preferences")?.get(key));
  }
}

class FakeIndexedDb {
  database: FakeDatabase | undefined;

  open(_name: string, _version: number): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      if (!this.database) {
        this.database = new FakeDatabase();
        request.result = this.database;
        request.transaction = { abort: () => undefined } as unknown as FakeTransaction;
        request.onupgradeneeded?.(new Event("upgradeneeded"));
      }
      request.result = this.database!;
      request.onsuccess?.(new Event("success"));
    });
    return request;
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function installFakeStorage(): FakeIndexedDb {
  const indexedDb = new FakeIndexedDb();
  vi.stubGlobal("window", { indexedDB: indexedDb });
  return indexedDb;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Native Account preferences", () => {
  it("creates a default once and keeps Account ID only as the IndexedDB key", async () => {
    const indexedDb = installFakeStorage();
    const first = await loadNativeAccountPreferences("account-one", "登録名");
    const second = await loadNativeAccountPreferences("account-one", "別名");

    expect(first).toMatchObject({
      schema_version: 1,
      revision: 0,
      display_name: "登録名",
      output_locale: null,
      instructions: ""
    });
    expect(second).toEqual(first);
    expect(indexedDb.database?.read("account-one")).not.toHaveProperty("account_id");
    expect(nativeAccountPreferencesDatabaseName).toBe("samurai-account-preferences-v1");
  });

  it("checks the expected revision in the transaction and increments only after a successful write", async () => {
    installFakeStorage();
    await loadNativeAccountPreferences("account-two", "登録名");

    const saved = await saveNativeAccountPreferences("account-two", 0, {
      display_name: "新しい名前",
      output_locale: "ja",
      instructions: "回答の前提"
    });
    expect(saved).toMatchObject({ revision: 1, display_name: "新しい名前", output_locale: "ja", instructions: "回答の前提" });
    await expect(saveNativeAccountPreferences("account-two", 0, {
      display_name: "競合",
      output_locale: null,
      instructions: ""
    })).rejects.toMatchObject({ code: "personal_settings_conflict" });
    await expect(loadNativeAccountPreferences("account-two", "別名")).resolves.toEqual(saved);
  });

  it("does not overwrite an unknown schema or malformed record", async () => {
    const indexedDb = installFakeStorage();
    indexedDb.database = new FakeDatabase();
    indexedDb.database.seed("account-three", {
      schema_version: 2,
      revision: 4,
      display_name: "旧形式",
      output_locale: null,
      instructions: "保持",
      updated_at: new Date().toISOString()
    });

    await expect(loadNativeAccountPreferences("account-three", "新しい既定値"))
      .rejects.toMatchObject({ code: "personal_settings_schema_unsupported" });
    expect(indexedDb.database.read("account-three")).toMatchObject({ schema_version: 2, display_name: "旧形式" });

    indexedDb.database.seed("account-four", {
      schema_version: 1,
      revision: 0,
      display_name: "不正",
      output_locale: null,
      instructions: "",
      updated_at: new Date().toISOString(),
      account_id: "should-not-be-stored"
    });
    await expect(loadNativeAccountPreferences("account-four", "新しい既定値"))
      .rejects.toMatchObject({ code: "personal_settings_record_invalid" });
    expect(indexedDb.database.read("account-four")).toHaveProperty("account_id", "should-not-be-stored");
  });

  it("reports unsupported browsers and failed writes instead of returning success", async () => {
    vi.stubGlobal("window", {});
    await expect(loadNativeAccountPreferences("account-five", "登録名"))
      .rejects.toMatchObject({ code: "personal_settings_storage_unavailable" });

    const indexedDb = installFakeStorage();
    await loadNativeAccountPreferences("account-six", "登録名");
    indexedDb.database!.failWrites = true;
    await expect(saveNativeAccountPreferences("account-six", 0, {
      display_name: "保存失敗",
      output_locale: null,
      instructions: ""
    })).rejects.toMatchObject({ code: "personal_settings_storage_failed" });
    indexedDb.database!.failWrites = false;
    await expect(loadNativeAccountPreferences("account-six", "別名")).resolves.toMatchObject({ revision: 0, display_name: "登録名" });
  });
});
