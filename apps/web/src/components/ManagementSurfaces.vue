<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Archive from "lucide-vue-next/dist/esm/icons/archive.js";
import Check from "lucide-vue-next/dist/esm/icons/check.js";
import MessageCircle from "lucide-vue-next/dist/esm/icons/message-circle.js";
import Pause from "lucide-vue-next/dist/esm/icons/pause.js";
import Play from "lucide-vue-next/dist/esm/icons/play.js";
import RefreshCw from "lucide-vue-next/dist/esm/icons/refresh-cw.js";
import Save from "lucide-vue-next/dist/esm/icons/save.js";
import type { AutomationJobRecord, WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { AutomationRunSummary, SkillIndexEntry, WikiDetail } from "../lib/api";

type Mode = "wiki" | "skills" | "automations";
const props = defineProps<{
  mode: Mode;
  loading: boolean;
  error: string | null;
  wikiPages: Array<WikiFrontmatter & { file_path: string }>;
  wikiDetail: WikiDetail | null;
  wikiDiagnostics: Record<string, unknown> | null;
  skills: SkillIndexEntry[];
  skillDetail: { skill: SkillIndexEntry; markdown: string } | null;
  automationJobs: AutomationJobRecord[];
  automationRuns: AutomationRunSummary[];
  openWiki: (id: string) => void | Promise<void>;
  saveWiki: (id: string, input: { title: string; content: string }) => void | Promise<void>;
  archiveWiki: (id: string) => void | Promise<void>;
  reindexWiki: () => void | Promise<void>;
  openSkill: (id: string) => void | Promise<void>;
  saveSkill: (id: string, input: { title: string; description: string; content: string }) => void | Promise<void>;
  setSkillActive: (id: string, active: boolean) => void | Promise<void>;
  setAutomationStatus: (id: string, status: "enabled" | "disabled") => void | Promise<void>;
  useInChat: (kind: "wiki" | "skill" | "automation", id: string, title: string) => void;
}>();

const wikiTitle = ref("");
const wikiContent = ref("");
const skillTitle = ref("");
const skillDescription = ref("");
const skillContent = ref("");
watch(() => props.wikiDetail, (detail) => { wikiTitle.value = detail?.wiki.title ?? ""; wikiContent.value = detail?.content ?? ""; }, { immediate: true });
watch(() => props.skillDetail, (detail) => { skillTitle.value = detail?.skill.title ?? ""; skillDescription.value = detail?.skill.description ?? ""; skillContent.value = detail?.markdown ?? ""; }, { immediate: true });
const diagnosticSummary = computed(() => Object.entries(props.wikiDiagnostics ?? {}).filter(([, value]) => typeof value === "number" || typeof value === "boolean").slice(0, 6));
</script>

<template>
  <section class="management-surface">
    <div v-if="props.loading" class="empty-note">読み込んでいます</div>
    <div v-else-if="props.error" class="empty-note">{{ props.error }}</div>

    <template v-else-if="props.mode === 'wiki'">
      <div class="management-list">
        <div class="management-toolbar"><span>Knowledge Wiki</span><button type="button" @click="props.reindexWiki"><RefreshCw :size="14" />再索引</button></div>
        <button v-for="page in props.wikiPages" :key="page.id" class="management-row" type="button" @click="props.openWiki(page.id)"><span><strong>{{ page.title }}</strong><small>{{ page.state }} ・ {{ page.tags.join(', ') || 'タグなし' }}</small></span><em>{{ page.content_locale }}</em></button>
      </div>
      <article v-if="props.wikiDetail" class="management-editor lit-surface">
        <input v-model="wikiTitle" aria-label="Wiki title" />
        <textarea v-model="wikiContent" aria-label="Wiki content" />
        <div class="management-actions"><button type="button" @click="props.saveWiki(props.wikiDetail.wiki.id, { title: wikiTitle, content: wikiContent })"><Save :size="14" />保存</button><button type="button" @click="props.useInChat('wiki', props.wikiDetail.wiki.id, wikiTitle)"><MessageCircle :size="14" />Chatで使う</button><button type="button" @click="props.archiveWiki(props.wikiDetail.wiki.id)"><Archive :size="14" />保管</button></div>
        <div v-if="diagnosticSummary.length" class="diagnostic-strip"><span v-for="[key, value] in diagnosticSummary" :key="key"><small>{{ key }}</small><strong>{{ value }}</strong></span></div>
      </article>
    </template>

    <template v-else-if="props.mode === 'skills'">
      <div class="management-list">
        <div class="management-toolbar"><span>Skills</span></div>
        <button v-for="skill in props.skills" :key="skill.id" class="management-row" type="button" @click="props.openSkill(skill.id)"><span><strong>{{ skill.title }}</strong><small>{{ skill.description }}</small></span><em>{{ skill.state }}</em></button>
      </div>
      <article v-if="props.skillDetail" class="management-editor lit-surface">
        <input v-model="skillTitle" aria-label="Skill title" />
        <input v-model="skillDescription" aria-label="Skill description" />
        <textarea v-model="skillContent" aria-label="Skill content" />
        <div class="management-actions"><button type="button" @click="props.saveSkill(props.skillDetail.skill.id, { title: skillTitle, description: skillDescription, content: skillContent })"><Save :size="14" />保存</button><button type="button" @click="props.useInChat('skill', props.skillDetail.skill.id, skillTitle)"><MessageCircle :size="14" />Chatで使う</button><button v-if="props.skillDetail.skill.state === 'archived'" type="button" @click="props.setSkillActive(props.skillDetail.skill.id, true)"><Check :size="14" />有効化</button><button v-else type="button" @click="props.setSkillActive(props.skillDetail.skill.id, false)"><Pause :size="14" />無効化</button></div>
      </article>
    </template>

    <template v-else>
      <div class="management-list management-list-wide">
        <div class="management-toolbar"><span>Automations</span></div>
        <article v-for="job in props.automationJobs" :key="job.id" class="automation-row lit-surface"><div><strong>{{ job.title }}</strong><small>{{ job.schedule }} ・ 次回 {{ job.next_run_at || '未定' }}</small></div><div class="management-actions"><button type="button" @click="props.useInChat('automation', job.id, job.title)"><MessageCircle :size="14" />Chat</button><button v-if="job.status === 'enabled'" type="button" @click="props.setAutomationStatus(job.id, 'disabled')"><Pause :size="14" />停止</button><button v-else type="button" @click="props.setAutomationStatus(job.id, 'enabled')"><Play :size="14" />再開</button></div></article>
        <div class="management-toolbar history-label"><span>最近の実行</span></div>
        <div v-for="run in props.automationRuns" :key="run.id" class="automation-run"><span>{{ run.kind }}</span><small>{{ run.status }} ・ {{ run.started_at }}</small></div>
      </div>
    </template>
  </section>
</template>
