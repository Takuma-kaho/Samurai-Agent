<script setup lang="ts">
import { onMounted, ref } from "vue";
import Check from "lucide-vue-next/dist/esm/icons/check.js";
import RotateCcw from "lucide-vue-next/dist/esm/icons/rotate-ccw.js";
import X from "lucide-vue-next/dist/esm/icons/x.js";
import type { MessagePresentationRecord, OptimizationCandidate } from "@samurai-agent/core-schemas";
import { api, type SkillOptimizationDetail } from "../lib/api";

const props = defineProps<{ presentation: MessagePresentationRecord }>();
const emit = defineEmits<{ changed: [] }>();
const detail = ref<SkillOptimizationDetail | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);

function stateValue(key: string): string {
  const value = props.presentation.view_state?.[key];
  return typeof value === "string" ? value : "";
}

function numberValue(key: string): number {
  const value = props.presentation.view_state?.[key];
  return typeof value === "number" ? value : 0;
}

function currentCandidate(): OptimizationCandidate | undefined {
  const candidateId = stateValue("candidate_id");
  return detail.value?.candidates.find((candidate) => candidate.id === candidateId) ?? detail.value?.candidates[0];
}

async function load() {
  const runId = stateValue("optimization_run_id") || props.presentation.view_id;
  if (!runId) return;
  loading.value = true;
  try {
    detail.value = await api.getSkillOptimization(runId);
    error.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Skill改善候補を読み込めませんでした";
  } finally {
    loading.value = false;
  }
}

async function run(command: "skill.optimization.promote" | "skill.optimization.reject") {
  const candidate = currentCandidate();
  const runId = stateValue("optimization_run_id") || props.presentation.view_id;
  if (!candidate || !runId) return;
  busy.value = true;
  try {
    await api.runDomainCommand(command, { optimization_run_id: runId, candidate_id: candidate.id });
    await load();
    emit("changed");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Skill改善候補を更新できませんでした";
  } finally {
    busy.value = false;
  }
}

onMounted(() => { void load(); });
</script>

<template>
  <article class="skill-optimization-card">
    <header class="skill-optimization-card-head">
      <span class="codex-card-icon"><RotateCcw :size="18" /></span>
      <span class="codex-card-main">
        <strong>{{ props.presentation.title || "Skill改善候補" }}</strong>
        <small>{{ props.presentation.subtitle || "GEPAで作成" }}</small>
      </span>
    </header>
    <p v-if="loading" class="skill-optimization-card-note">評価結果を読み込み中…</p>
    <template v-else-if="detail && currentCandidate()">
      <div class="skill-optimization-score">
        <span>holdout</span>
        <strong>{{ currentCandidate()!.holdout_score.toFixed(1) }}点</strong>
        <em>{{ currentCandidate()!.holdout_delta >= 0 ? '+' : '' }}{{ currentCandidate()!.holdout_delta.toFixed(1) }}点</em>
      </div>
      <p class="skill-optimization-card-note">{{ currentCandidate()!.status === 'passed' ? '安全検証・関連テスト・退行チェックを通過。' : '完了条件を満たさなかったため、元のSkillは変更していない。' }}</p>
      <ul v-if="currentCandidate()!.feedback.length > 0" class="skill-optimization-feedback">
        <li v-for="item in currentCandidate()!.feedback.slice(0, 3)" :key="item">{{ item }}</li>
      </ul>
      <details class="skill-optimization-body">
        <summary>候補本文を見る</summary>
        <pre>{{ currentCandidate()!.body }}</pre>
      </details>
      <div v-if="currentCandidate()!.status === 'passed'" class="skill-optimization-actions">
        <button type="button" :disabled="busy" @click="run('skill.optimization.promote')"><Check :size="14" />反映する</button>
        <button type="button" :disabled="busy" @click="run('skill.optimization.reject')"><X :size="14" />見送る</button>
      </div>
    </template>
    <p v-else class="skill-optimization-card-note">{{ error || "候補が見つかりません" }}</p>
    <p v-if="error && detail" class="skill-optimization-error">{{ error }}</p>
  </article>
</template>
