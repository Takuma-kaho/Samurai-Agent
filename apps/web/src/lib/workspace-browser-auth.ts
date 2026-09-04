import { io, type Socket } from "socket.io-client";

export interface BrowserWorkspaceConnection {
  /** Stable local ID for this Server + Account credential pair. */
  id: string;
  label: string;
  serverUrl: string;
  workspaceId: string;
  accountId: string;
  publicKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserWorkspaceConnectionInput {
  label: string;
  serverUrl: string;
  workspaceId: string;
  accountId: string;
  publicKey: string;
  privateKey: string;
}

export interface BrowserWorkspaceRequestInput {
  method: string;
  path: string;
  /** Use a non-active stored credential for account-scoped directory reads. */
  connectionId?: string;
  workspaceScoped?: boolean;
  operationId?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export interface BrowserWorkspaceRealtimeEvent {
  type: "event" | "access_changed" | "access_revoked" | "room_access_changed" | "room_access_revoked";
  workspaceId: string;
  connectionId?: string;
  roomId?: string;
  kind?: string;
  eventId?: string;
  cursor?: string;
}

interface StoredBrowserWorkspaceConnection extends BrowserWorkspaceConnection {
  privateKey: CryptoKey;
}

const databaseName = "samurai-workspace-browser";
const databaseVersion = 2;
const objectStoreName = "connections";
const activeConnectionKey = "active";
const connectionKeyPrefix = "connection:";
let cachedConnection: StoredBrowserWorkspaceConnection | null | undefined;
let connectionLoad: Promise<StoredBrowserWorkspaceConnection | undefined> | undefined;
let cachedConnections: StoredBrowserWorkspaceConnection[] | undefined;
let connectionsLoad: Promise<StoredBrowserWorkspaceConnection[]> | undefined;
let browserRealtimeSocket: Socket | undefined;
let browserRealtimeGeneration = 0;
let browserRealtimeLastCursor: string | undefined;
const browserRealtimeSeenEventIds = new Set<string>();
const browserRealtimeListeners = new Set<(event: BrowserWorkspaceRealtimeEvent | undefined) => void>();

export async function loadBrowserWorkspaceConnection(): Promise<BrowserWorkspaceConnection | undefined> {
  const connection = await loadStoredConnection();
  return connection ? publicConnection(connection) : undefined;
}

/** Return every stored Browser credential without exposing private keys. */
export async function loadBrowserWorkspaceConnections(): Promise<BrowserWorkspaceConnection[]> {
  return (await loadStoredConnections()).map(publicConnection);
}

/**
 * Transitional workspace selection for the browser bridge. The value is only
 * a routing candidate; the caller must obtain the account-scoped list first
 * and then re-authorize the selected Workspace before opening content.
 */
export async function selectBrowserWorkspaceConnection(connectionId: string): Promise<BrowserWorkspaceConnection> {
  const connection = (await loadStoredConnections()).find((item) => item.id === connectionId);
  if (!connection) throw new Error("workspace_connection_not_found");
  await setActiveBrowserWorkspaceConnection(connection);
  return publicConnection(connection);
}

export async function selectBrowserWorkspaceCandidate(input: string | { connectionId: string; workspaceId: string }): Promise<BrowserWorkspaceConnection> {
  const workspaceId = typeof input === "string" ? input : input.workspaceId;
  const normalizedWorkspaceId = requiredOpaqueId(workspaceId, "workspace_id_invalid");
  const connection = typeof input === "string"
    ? await loadStoredConnection()
    : (await loadStoredConnections()).find((item) => item.id === input.connectionId);
  if (!connection) throw new Error("workspace_connection_required");
  if (typeof input !== "string") await setActiveBrowserWorkspaceConnection(connection);
  const updated: StoredBrowserWorkspaceConnection = {
    ...connection,
    workspaceId: normalizedWorkspaceId,
    updatedAt: new Date().toISOString()
  };
  await writeStoredConnection(updated);
  cachedConnection = updated;
  cachedConnections = (await loadStoredConnections()).map((item) => item.id === updated.id ? updated : item);
  browserRealtimeLastCursor = undefined;
  browserRealtimeSeenEventIds.clear();
  restartBrowserWorkspaceRealtime();
  return publicConnection(updated);
}

export async function configureBrowserWorkspaceConnection(input: BrowserWorkspaceConnectionInput): Promise<BrowserWorkspaceConnection> {
  if (typeof window === "undefined" || !window.crypto?.subtle || !window.indexedDB) {
    throw new Error("browser_workspace_secure_storage_unavailable");
  }
  const label = requiredText(input.label, "workspace_browser_label_required", 100);
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const workspaceId = requiredOpaqueId(input.workspaceId, "workspace_id_invalid");
  const publicDer = decodePublicKey(input.publicKey);
  const privateKey = await importPrivateKey(input.privateKey);
  const accountId = await accountIdFromPublicKey(publicDer);
  if (accountId !== requiredOpaqueId(input.accountId, "account_id_invalid")) {
    throw new Error("workspace_browser_account_mismatch");
  }
  await verifyKeyPair(privateKey, publicDer);
  const connection: StoredBrowserWorkspaceConnection = {
    id: await browserConnectionId(serverUrl, accountId),
    label,
    serverUrl,
    workspaceId,
    accountId,
    publicKey: `base64:${encodeBase64(publicDer)}`,
    createdAt: new Date().toISOString(),
    privateKey,
    updatedAt: new Date().toISOString()
  };
  await writeStoredConnection(connection);
  cachedConnection = connection;
  cachedConnections = [...(await loadStoredConnections()).filter((item) => item.id !== connection.id), connection];
  await setActiveBrowserWorkspaceConnection(connection);
  browserRealtimeLastCursor = undefined;
  browserRealtimeSeenEventIds.clear();
  restartBrowserWorkspaceRealtime();
  return publicConnection(connection);
}

export async function clearBrowserWorkspaceConnection(): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) return;
  const connection = await loadStoredConnection();
  await withStore("readwrite", async (store) => {
    store.delete(activeConnectionKey);
    if (connection) store.delete(`${connectionKeyPrefix}${connection.id}`);
  });
  cachedConnection = null;
  connectionLoad = undefined;
  cachedConnections = undefined;
  connectionsLoad = undefined;
  browserRealtimeLastCursor = undefined;
  browserRealtimeSeenEventIds.clear();
  restartBrowserWorkspaceRealtime();
}

/**
 * Web and Desktop receive the same small, sanitized notice shape. The
 * browser keeps the Ed25519 private key in IndexedDB and signs the Socket.IO
 * handshake exactly as it signs HTTP requests; no generic socket payload is
 * exposed to the Vue renderer.
 */
export function subscribeBrowserWorkspaceRealtime(
  listener: (event: BrowserWorkspaceRealtimeEvent | undefined) => void
): () => void {
  browserRealtimeListeners.add(listener);
  void ensureBrowserWorkspaceRealtime();
  return () => {
    browserRealtimeListeners.delete(listener);
    if (browserRealtimeListeners.size === 0) {
      browserRealtimeSocket?.disconnect();
      browserRealtimeSocket = undefined;
      browserRealtimeGeneration += 1;
    }
  };
}

export async function browserWorkspaceRequest<T = unknown>(input: BrowserWorkspaceRequestInput): Promise<T> {
  const connection = input.connectionId
    ? (await loadStoredConnections()).find((item) => item.id === input.connectionId)
    : await loadStoredConnection();
  if (!connection) throw new Error("workspace_connection_required");
  const url = new URL(input.path, `${connection.serverUrl}/`);
  const base = new URL(connection.serverUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("workspace_server_request_origin_invalid");
  }
  const requestId = `request_${crypto.randomUUID()}`;
  const timestamp = String(Date.now());
  const body = input.body ?? {};
  const payload = await createSignaturePayload({
    method: input.method,
    path: url.pathname,
    ...(input.workspaceScoped ? { workspaceId: connection.workspaceId } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    requestId,
    timestamp,
    body
  });
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    connection.privateKey,
    new TextEncoder().encode(payload)
  )));
  const response = await fetch(url, {
    method: input.method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-samurai-account-id": connection.accountId,
      "x-samurai-request-id": requestId,
      "x-samurai-timestamp": timestamp,
      "x-samurai-signature": signature,
      ...(input.workspaceScoped ? { "x-samurai-workspace-id": connection.workspaceId } : {}),
      ...(input.operationId ? { "x-samurai-operation-id": input.operationId } : {}),
      ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {})
    },
    ...(input.method === "GET" ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let responseBody: unknown = undefined;
  if (text) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = { error: "workspace_server_response_invalid" };
    }
  }
  if (!response.ok) {
    const errorValue = responseBody && typeof responseBody === "object" ? (responseBody as { error?: unknown }).error : undefined;
    const code = typeof errorValue === "string"
      ? errorValue
      : errorValue && typeof errorValue === "object" && typeof (errorValue as { code?: unknown }).code === "string"
        ? (errorValue as { code: string }).code
        : "workspace_server_request_failed";
    throw new Error(`${code}:${response.status}`);
  }
  return responseBody as T;
}

export async function browserWorkspaceHealth(connectionId?: string): Promise<unknown> {
  const connection = connectionId
    ? (await loadStoredConnections()).find((item) => item.id === connectionId)
    : await loadStoredConnection();
  if (!connection) {
    const target = typeof window === "undefined" ? undefined : window.location.origin;
    if (!target) throw new Error("workspace_connection_required");
    const response = await fetch(`${target}/api/health`, { redirect: "error" });
    return response.json();
  }
  return browserWorkspaceRequest({ method: "GET", path: "/api/health", ...(connectionId ? { connectionId } : {}) });
}

export async function registerBrowserWorkspaceAccount(displayName = "Samurai Account"): Promise<unknown> {
  const connection = await loadStoredConnection();
  if (!connection) throw new Error("workspace_connection_required");
  return browserWorkspaceRequest({
    method: "POST",
    path: "/api/account/register",
    body: {
      account_id: connection.accountId,
      public_key: connection.publicKey,
      display_name: requiredText(displayName, "account_display_name_required", 160)
    }
  });
}

export function createBrowserConnectionState(connection: BrowserWorkspaceConnection | undefined) {
  return connection
    ? {
        activeConnectionId: connection.id,
        connections: [connection]
      }
    : { connections: [] };
}

export async function createBrowserWorkspaceConnectionState() {
  const connections = await loadBrowserWorkspaceConnections();
  return {
    ...(connections[0] ? { activeConnectionId: (await loadBrowserWorkspaceConnection())?.id } : {}),
    connections
  };
}

function publicConnection(connection: StoredBrowserWorkspaceConnection): BrowserWorkspaceConnection {
  const { privateKey: _privateKey, ...publicValue } = connection;
  return publicValue;
}

async function loadStoredConnection(): Promise<StoredBrowserWorkspaceConnection | undefined> {
  if (cachedConnection !== undefined) return cachedConnection ?? undefined;
  if (connectionLoad) return connectionLoad;
  connectionLoad = loadStoredConnections().then((connections) => {
    const connection = cachedConnection ?? connections[0];
    cachedConnection = connection ?? null;
    return connection;
  }).finally(() => {
    connectionLoad = undefined;
  });
  return connectionLoad;
}

async function loadStoredConnections(): Promise<StoredBrowserWorkspaceConnection[]> {
  if (cachedConnections) return cachedConnections;
  if (connectionsLoad) return connectionsLoad;
  if (typeof window === "undefined" || !window.indexedDB) {
    cachedConnections = [];
    cachedConnection = null;
    return cachedConnections;
  }
  connectionsLoad = withStore<{ keys: IDBValidKey[]; values: unknown[] }>("readonly", async (store) => {
    const [keys, values] = await Promise.all([
      requestResult<IDBValidKey[]>(store.getAllKeys()),
      requestResult<unknown[]>(store.getAll())
    ]);
    return { keys, values };
  }).then(async ({ keys, values }) => {
    const activeIndex = keys.findIndex((key) => key === activeConnectionKey);
    const activeValue = activeIndex >= 0 ? values[activeIndex] : undefined;
    const recordById = new Map<string, StoredBrowserWorkspaceConnection>();
    for (const value of values) {
      if (isStoredConnection(value)) recordById.set(value.id, value);
    }
    const records = [...recordById.values()];
    // Version 1 stored the active record directly under "active". Migrate it
    // to a named record while retaining the active pointer.
    if (isStoredConnection(activeValue)) {
      if (!keys.some((key) => key === `${connectionKeyPrefix}${activeValue.id}`)) {
        recordById.set(activeValue.id, activeValue);
        records.splice(0, records.length, ...recordById.values());
      }
      await withStore("readwrite", (store) => {
        if (!keys.some((key) => key === `${connectionKeyPrefix}${activeValue.id}`)) {
          store.put(activeValue, `${connectionKeyPrefix}${activeValue.id}`);
        }
        store.put(activeValue.id, activeConnectionKey);
      });
    }
    const activeId = typeof activeValue === "string"
      ? activeValue
      : isStoredConnection(activeValue) ? activeValue.id : undefined;
    cachedConnections = records;
    cachedConnection = records.find((connection) => connection.id === activeId) ?? records[0] ?? null;
    return records;
  }).finally(() => {
    connectionsLoad = undefined;
  });
  return connectionsLoad;
}

async function setActiveBrowserWorkspaceConnection(connection: StoredBrowserWorkspaceConnection): Promise<void> {
  await withStore("readwrite", (store) => store.put(connection.id, activeConnectionKey));
  cachedConnection = connection;
  cachedConnections = [...(cachedConnections ?? []), connection].filter((item, index, values) => values.findIndex((candidate) => candidate.id === item.id) === index);
  browserRealtimeLastCursor = undefined;
  browserRealtimeSeenEventIds.clear();
  restartBrowserWorkspaceRealtime();
}

async function writeStoredConnection(connection: StoredBrowserWorkspaceConnection): Promise<void> {
  await withStore("readwrite", (store) => store.put(connection, `${connectionKeyPrefix}${connection.id}`));
}

function isStoredConnection(value: unknown): value is StoredBrowserWorkspaceConnection {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { serverUrl?: unknown }).serverUrl === "string"
    && typeof (value as { accountId?: unknown }).accountId === "string"
    && (value as { privateKey?: unknown }).privateKey);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(objectStoreName)) request.result.createObjectStore(objectStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("browser_workspace_database_open_failed"));
  });
}

async function withStore<T = void>(mode: IDBTransactionMode, callback: (store: IDBObjectStore) => Promise<T> | IDBRequest<T> | T | void): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(objectStoreName, mode);
    const store = transaction.objectStore(objectStoreName);
    let result: T | undefined;
    let callbackError: unknown;
    let callbackCompleted = false;
    try {
      const value = callback(store);
      if (value && typeof value === "object" && "onsuccess" in value) {
        const request = value as IDBRequest<T>;
        request.onsuccess = () => { result = request.result; callbackCompleted = true; };
        request.onerror = () => { callbackError = request.error; callbackCompleted = true; };
      } else if (value instanceof Promise) {
        value.then((resolved) => { result = resolved; callbackCompleted = true; }).catch((error) => { callbackError = error; callbackCompleted = true; });
      } else {
        result = value as T;
        callbackCompleted = true;
      }
    } catch (error) {
      callbackError = error;
      callbackCompleted = true;
    }
    transaction.oncomplete = () => {
      database.close();
      if (callbackError) reject(callbackError);
      else if (!callbackCompleted) reject(new Error("browser_workspace_database_request_incomplete"));
      else resolve(result as T);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? callbackError ?? new Error("browser_workspace_database_transaction_failed"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? callbackError ?? new Error("browser_workspace_database_transaction_aborted"));
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("browser_workspace_database_request_failed"));
  });
}

async function importPrivateKey(value: string): Promise<CryptoKey> {
  const der = decodePem(value, "PRIVATE KEY");
  return crypto.subtle.importKey("pkcs8", toArrayBuffer(der), { name: "Ed25519" }, false, ["sign"]);
}

async function verifyKeyPair(privateKey: CryptoKey, publicDer: Uint8Array): Promise<void> {
  const publicKey = await crypto.subtle.importKey("spki", toArrayBuffer(publicDer), { name: "Ed25519" }, false, ["verify"]);
  const challenge = new TextEncoder().encode(`samurai-browser-key-check:${crypto.randomUUID()}`);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, challenge);
  if (!await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, challenge)) {
    throw new Error("workspace_browser_key_pair_mismatch");
  }
}

function decodePublicKey(value: string): Uint8Array {
  const trimmed = value.trim();
  return trimmed.includes("BEGIN PUBLIC KEY")
    ? decodePem(trimmed, "PUBLIC KEY")
    : decodeBase64(trimmed.startsWith("base64:") ? trimmed.slice("base64:".length) : trimmed);
}

function decodePem(value: string, label: string): Uint8Array {
  const match = value.trim().match(new RegExp(`^-----BEGIN ${label}-----([\\s\\S]+)-----END ${label}-----$`));
  if (!match) throw new Error(`workspace_browser_${label.toLowerCase().replaceAll(" ", "_")}_invalid`);
  return decodeBase64(match[1]!.replace(/\s+/g, ""));
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("workspace_browser_key_encoding_invalid");
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(value: Uint8Array): string {
  return encodeBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function accountIdFromPublicKey(publicDer: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(publicDer)));
  return "account_" + Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

async function browserConnectionId(serverUrl: string, accountId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${serverUrl}\n${accountId}`)));
  return "browser_" + Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

async function ensureBrowserWorkspaceRealtime(): Promise<void> {
  if (browserRealtimeSocket || browserRealtimeListeners.size === 0) return;
  const connection = await loadStoredConnection();
  if (!connection || browserRealtimeListeners.size === 0) return;
  const generation = ++browserRealtimeGeneration;
  const socket = io(connection.serverUrl, {
    autoConnect: false,
    transports: ["websocket", "polling"],
    timeout: 10_000,
    auth: (callback) => {
      void browserWorkspaceSocketAuth(connection)
        .then(callback)
        .catch(() => callback({}));
    }
  });
  browserRealtimeSocket = socket;
  const isCurrent = () => generation === browserRealtimeGeneration && browserRealtimeSocket === socket;
  socket.on("connect", () => {
    if (!isCurrent()) return;
    void syncBrowserWorkspaceRealtime(socket, connection, isCurrent);
  });
  socket.on("workspace:v1:event", (event: unknown) => {
    if (!isCurrent() || !acceptBrowserPublicEvent(event)) return;
    notifyBrowserWorkspaceRealtime("event", connection.id, connection.workspaceId, event);
  });
  socket.on("workspace:event", (event: unknown) => {
    if (!isCurrent()) return;
    notifyBrowserWorkspaceRealtime("event", connection.id, connection.workspaceId, event);
    void refreshBrowserWorkspaceRealtimeRooms(socket, connection, isCurrent);
  });
  socket.on("workspace:access-changed", (event: unknown) => {
    if (!isCurrent()) return;
    notifyBrowserWorkspaceRealtime("access_changed", connection.id, connection.workspaceId, event);
    void refreshBrowserWorkspaceRealtimeRooms(socket, connection, isCurrent);
  });
  socket.on("workspace:room-access-changed", (event: unknown) => {
    if (!isCurrent()) return;
    notifyBrowserWorkspaceRealtime("room_access_changed", connection.id, connection.workspaceId, event);
    void refreshBrowserWorkspaceRealtimeRooms(socket, connection, isCurrent);
  });
  socket.on("workspace:room-access-revoked", (event: unknown) => {
    if (!isCurrent()) return;
    notifyBrowserWorkspaceRealtime("room_access_revoked", connection.id, connection.workspaceId, event);
  });
  socket.on("workspace:access-revoked", (event: unknown) => {
    if (!isCurrent()) return;
    notifyBrowserWorkspaceRealtime("access_revoked", connection.id, connection.workspaceId, event);
    socket.disconnect();
  });
  socket.on("disconnect", () => {
    if (isCurrent()) browserRealtimeSocket = undefined;
  });
  socket.connect();
}

async function browserWorkspaceSocketAuth(connection: StoredBrowserWorkspaceConnection): Promise<Record<string, string>> {
  const requestId = `socket_${crypto.randomUUID()}`;
  const timestamp = String(Date.now());
  const payload = await createSignaturePayload({
    method: "SOCKET",
    path: "/socket.io",
    workspaceId: connection.workspaceId,
    requestId,
    timestamp,
    body: {}
  });
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    connection.privateKey,
    new TextEncoder().encode(payload)
  )));
  return {
    account_id: connection.accountId,
    workspace_id: connection.workspaceId,
    request_id: requestId,
    timestamp,
    signature
  };
}

async function refreshBrowserWorkspaceRealtimeRooms(
  socket: Socket,
  connection: StoredBrowserWorkspaceConnection,
  isCurrent: () => boolean
): Promise<void> {
  try {
    const response = await browserWorkspaceRequest<{ rooms?: unknown }>({
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(connection.workspaceId)}/rooms`,
      workspaceScoped: true
    });
    if (!isCurrent() || !Array.isArray(response.rooms)) return;
    for (const room of response.rooms) {
      const roomId = room && typeof room === "object" ? (room as { id?: unknown }).id : undefined;
      if (typeof roomId === "string" && isWorkspaceOpaqueId(roomId)) {
        socket.emit("workspace:subscribe-room", { room_id: roomId });
      }
    }
  } catch {
    // Socket.IO reconnects and the next authorized event retry the sync.
  }
}

async function syncBrowserWorkspaceRealtime(
  socket: Socket,
  connection: StoredBrowserWorkspaceConnection,
  isCurrent: () => boolean
): Promise<void> {
  try {
    socket.emit("workspace:v1:subscribe", {});
    let afterCursor = browserRealtimeLastCursor;
    for (let page = 0; page < 20 && isCurrent(); page += 1) {
      const query = afterCursor ? `?after_cursor=${encodeURIComponent(afterCursor)}&limit=500` : "?limit=500";
      const response = await browserWorkspaceRequest<{ events?: unknown; next_cursor?: unknown; has_more?: unknown }>({
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(connection.workspaceId)}/events${query}`,
        workspaceScoped: true
      });
      if (!isCurrent() || !Array.isArray(response.events)) break;
      for (const event of response.events) {
        if (!acceptBrowserPublicEvent(event)) continue;
        notifyBrowserWorkspaceRealtime("event", connection.id, connection.workspaceId, event);
      }
      const nextCursor = typeof response.next_cursor === "string" ? response.next_cursor : undefined;
      if (response.has_more === true && nextCursor) {
        afterCursor = nextCursor;
        continue;
      }
      break;
    }
    await refreshBrowserWorkspaceRealtimeRooms(socket, connection, isCurrent);
  } catch {
    // The next Socket reconnect retries HTTP replay. A missed notification is
    // never treated as a successful synchronization.
  }
}

function acceptBrowserPublicEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const value = event as { event_id?: unknown; cursor?: unknown };
  if (typeof value.event_id === "string") {
    if (browserRealtimeSeenEventIds.has(value.event_id)) return false;
    browserRealtimeSeenEventIds.add(value.event_id);
    if (browserRealtimeSeenEventIds.size > 2_000) {
      const first = browserRealtimeSeenEventIds.values().next().value;
      if (typeof first === "string") browserRealtimeSeenEventIds.delete(first);
    }
  }
  if (typeof value.cursor === "string") browserRealtimeLastCursor = value.cursor;
  return true;
}

function notifyBrowserWorkspaceRealtime(
  type: BrowserWorkspaceRealtimeEvent["type"],
  connectionId: string,
  expectedWorkspaceId: string,
  event: unknown
): void {
  if (!event || typeof event !== "object") return;
  const value = event as { workspaceId?: unknown; roomId?: unknown; kind?: unknown; event_type?: unknown; scope?: { workspace_id?: unknown; room_id?: unknown } };
  const workspaceId = value.workspaceId ?? value.scope?.workspace_id;
  if (workspaceId !== expectedWorkspaceId) return;
  const notice: BrowserWorkspaceRealtimeEvent = { type, connectionId, workspaceId: expectedWorkspaceId };
  const roomId = value.roomId ?? value.scope?.room_id;
  if (typeof roomId === "string" && isWorkspaceOpaqueId(roomId)) notice.roomId = roomId;
  const kind = value.kind ?? value.event_type;
  if (typeof kind === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(kind)) notice.kind = kind;
  if (typeof (value as { event_id?: unknown }).event_id === "string") notice.eventId = (value as { event_id: string }).event_id;
  if (typeof (value as { cursor?: unknown }).cursor === "string") notice.cursor = (value as { cursor: string }).cursor;
  for (const listener of browserRealtimeListeners) listener(notice);
}

function restartBrowserWorkspaceRealtime(): void {
  browserRealtimeGeneration += 1;
  browserRealtimeSocket?.disconnect();
  browserRealtimeSocket = undefined;
  if (browserRealtimeListeners.size > 0) void ensureBrowserWorkspaceRealtime();
}

function isWorkspaceOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}

async function createSignaturePayload(input: {
  method: string;
  path: string;
  workspaceId?: string;
  operationId?: string;
  idempotencyKey?: string;
  requestId: string;
  timestamp: string;
  body: unknown;
}): Promise<string> {
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error("account_signature_timestamp_invalid");
  const bodyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(input.body))));
  return [
    "samurai-account-request-v1",
    input.method.toUpperCase(),
    input.path,
    input.workspaceId ?? "",
    input.operationId ?? "",
    input.idempotencyKey ?? "",
    input.requestId,
    String(Math.trunc(timestamp)),
    Array.from(bodyDigest).map((byte) => byte.toString(16).padStart(2, "0")).join("")
  ].join("\n");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("workspace_browser_request_body_invalid");
}

function normalizeServerUrl(value: string): string {
  const url = new URL(requiredText(value, "workspace_server_url_required", 2_000));
  if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("workspace_server_url_invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredText(value: string, code: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(code);
  return normalized;
}

function requiredOpaqueId(value: string, code: string): string {
  const normalized = requiredText(value, code, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw new Error(code);
  return normalized;
}
