<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import Check from "lucide-vue-next/dist/esm/icons/check.js";
import ClipboardPaste from "lucide-vue-next/dist/esm/icons/clipboard-paste.js";
import Link2 from "lucide-vue-next/dist/esm/icons/link-2.js";
import Plus from "lucide-vue-next/dist/esm/icons/plus.js";
import type { SupportedLocale } from "@samurai-agent/core-schemas";
import type { BrowserWorkspaceConnectionInput } from "../lib/workspace-browser-auth";

export interface NativeWorkspaceConnection {
  id: string;
  label: string;
  serverUrl: string;
  workspaceId: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
}

const props = defineProps<{
  uiLocale: SupportedLocale;
  available: boolean;
  loading: boolean;
  error: string | null;
  activeConnectionId?: string;
  connections: NativeWorkspaceConnection[];
  serverStatus?: { message: string; tone: "ready" | "warning" | "error" };
  selectConnection: (connectionId: string) => void | Promise<void>;
  saveConnection: (input: { label: string; serverUrl: string; workspaceId: string; accountId: string }) => void | Promise<void>;
  browserMode?: boolean;
  saveBrowserConnection?: (input: BrowserWorkspaceConnectionInput) => void | Promise<void>;
  registerAccount?: () => void | Promise<void>;
  importIdentity?: () => void | Promise<void>;
}>();

const draft = reactive({ label: "", serverUrl: "", workspaceId: "", accountId: "", publicKey: "", privateKey: "" });
const formError = ref<string | null>(null);
const saving = ref(false);
const japanese = computed(() => props.uiLocale === "ja");

async function addConnection(): Promise<void> {
  formError.value = null;
  if (!draft.label.trim() || !draft.serverUrl.trim() || !draft.workspaceId.trim() || !draft.accountId.trim()) {
    formError.value = japanese.value ? "4項目を入力してください。" : "Fill in all four fields.";
    return;
  }
  if (props.browserMode && (!props.saveBrowserConnection || !draft.publicKey.trim() || !draft.privateKey.trim())) {
    formError.value = japanese.value ? "公開鍵と秘密鍵も入力してください。" : "Enter both the public and private keys.";
    return;
  }
  saving.value = true;
  try {
    if (props.browserMode && props.saveBrowserConnection) {
      await props.saveBrowserConnection({
        label: draft.label.trim(),
        serverUrl: draft.serverUrl.trim(),
        workspaceId: draft.workspaceId.trim(),
        accountId: draft.accountId.trim(),
        publicKey: draft.publicKey.trim(),
        privateKey: draft.privateKey.trim()
      });
    } else {
      await props.saveConnection({
        label: draft.label.trim(),
        serverUrl: draft.serverUrl.trim(),
        workspaceId: draft.workspaceId.trim(),
        accountId: draft.accountId.trim()
      });
    }
    draft.label = "";
    draft.serverUrl = "";
    draft.workspaceId = "";
    draft.accountId = "";
    draft.publicKey = "";
    draft.privateKey = "";
  } catch {
    formError.value = japanese.value ? "接続先を保存できませんでした。" : "Could not save this connection.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="props.available" class="workspace-connection-settings">
    <div class="settings-head">{{ japanese ? "Workspace Server" : "Workspace Server" }}</div>
    <p class="workspace-connection-note">
      {{ props.browserMode
        ? (japanese ? "秘密鍵はサーバーへ送らず、このブラウザのIndexedDBにCryptoKeyとして保存します。ブラウザの利用者とページの安全性を確認してください。" : "The private key is not sent to the server; this browser stores it as a CryptoKey in IndexedDB. Use only a browser and page you trust.")
        : (japanese ? "接続先一覧には URL・Workspace ID・Account だけを保存します。秘密鍵はWeb画面へ入れず、Desktopがこの端末の保護領域へ直接読み込みます。" : "Connections keep only the URL, Workspace ID, and Account. The Desktop imports a private key directly into protected storage without exposing it to this page.") }}
    </p>

    <p v-if="props.serverStatus" class="workspace-connection-status" :class="`is-${props.serverStatus.tone}`">{{ props.serverStatus.message }}</p>

    <div v-if="props.connections.length" class="workspace-connection-list" aria-label="Workspace Server connections">
      <button
        v-for="connection in props.connections"
        :key="connection.id"
        class="workspace-connection-row"
        :class="{ 'is-active': connection.id === props.activeConnectionId }"
        type="button"
        :disabled="props.loading"
        @click="props.selectConnection(connection.id)"
      >
        <span class="workspace-connection-mark"><Check v-if="connection.id === props.activeConnectionId" :size="13" /><Link2 v-else :size="13" /></span>
        <span class="workspace-connection-copy">
          <strong>{{ connection.label }}</strong>
          <small>{{ connection.workspaceId }} · {{ connection.accountId }}</small>
          <em>{{ connection.serverUrl }}</em>
        </span>
        <span v-if="connection.id === props.activeConnectionId" class="workspace-connection-active">{{ japanese ? "選択中" : "Selected" }}</span>
      </button>
    </div>
    <p v-else class="workspace-connection-empty">{{ japanese ? "まだ接続先はありません。" : "No Workspace Server connections yet." }}</p>

    <form class="workspace-connection-form" @submit.prevent="addConnection">
      <label>
        <span>{{ japanese ? "名前" : "Name" }}</span>
        <input v-model="draft.label" maxlength="100" :placeholder="japanese ? '自宅 / 会社 / Hosted' : 'Home / Work / Hosted'" autocomplete="off" />
      </label>
      <label>
        <span>Server URL</span>
        <input v-model="draft.serverUrl" inputmode="url" placeholder="https://samurai.example" autocomplete="url" />
      </label>
      <label>
        <span>Workspace ID</span>
        <input v-model="draft.workspaceId" maxlength="128" placeholder="workspace_team" autocomplete="off" />
      </label>
      <label>
        <span>Account</span>
        <input v-model="draft.accountId" maxlength="128" placeholder="account_..." autocomplete="off" />
      </label>
      <label v-if="props.browserMode">
        <span>Public key</span>
        <textarea v-model="draft.publicKey" rows="3" autocomplete="off" placeholder="-----BEGIN PUBLIC KEY-----" />
      </label>
      <label v-if="props.browserMode">
        <span>Private key</span>
        <textarea v-model="draft.privateKey" rows="4" autocomplete="off" placeholder="Paste private key material" />
      </label>
      <p v-if="props.error || formError" class="workspace-connection-error">{{ formError ?? props.error }}</p>
      <button class="workspace-connection-add" type="submit" :disabled="saving || props.loading"><Plus :size="15" />{{ japanese ? (props.browserMode ? "ブラウザ接続を保存" : "接続先を保存") : (props.browserMode ? "Save browser connection" : "Save connection") }}</button>
      <button v-if="props.activeConnectionId && props.importIdentity" class="workspace-connection-register" type="button" :disabled="saving || props.loading" @click="props.importIdentity">
        <ClipboardPaste :size="15" />{{ japanese ? "コピー済みの秘密鍵をこの端末へ安全に読み込む" : "Import copied private key into this device" }}
      </button>
      <button v-if="props.activeConnectionId && props.registerAccount" class="workspace-connection-register" type="button" :disabled="saving || props.loading" @click="props.registerAccount">
        {{ japanese ? "本人情報をサーバーへ登録" : "Register account with server" }}
      </button>
    </form>
  </div>
</template>
