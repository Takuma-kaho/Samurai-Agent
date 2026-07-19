import { stableHash, type BackendRunRecord, type JsonValue, type ResourceRef } from "@samurai-agent/core-schemas";

export type LearningSignalKind = "correction"|"undo"|"rerun"|"artifact_revision"|"surface_revision"|"dismiss"|"pin"|"explicit_feedback";
export interface LearningSignal { id:string; kind:LearningSignalKind; explicit:boolean; session_id:string; run_id:string; task_fingerprint:string; resource_ref?:ResourceRef; value:number; created_at:string; }
export interface TaskFingerprint { id:string; version:1; intent:string; domain:string; operation_kinds:string[]; tool_sequence:string[]; output_kind:string; expected_checks:string[]; }

export function createTaskFingerprint(run: BackendRunRecord): TaskFingerprint {
  const metadata=run.metadata as Record<string,JsonValue>; const value={version:1 as const,intent:normalizeIntent(run.input_summary),domain:stringValue(metadata.domain)??"general",operation_kinds:stringArray(metadata.operation_kinds),tool_sequence:stringArray(metadata.tool_sequence),output_kind:stringValue(metadata.output_kind)??"text",expected_checks:stringArray(metadata.expected_checks)};
  return{id:stableHash(value),...value};
}
export function evaluateFingerprintCohort(input:{fingerprint:string;before:Array<{quality:number;corrections:number}>;after:Array<{quality:number;corrections:number}>;signals:LearningSignal[];minSamples?:number}){
  const min=input.minSamples??3;if(input.before.length<min||input.after.length<min)return{assessment:"inconclusive" as const,reason:"insufficient_samples",confidence:0,effect:0,signal_count:input.signals.filter(x=>x.task_fingerprint===input.fingerprint).length};
  const before=average(input.before.map(x=>x.quality-x.corrections*10)),after=average(input.after.map(x=>x.quality-x.corrections*10)),effect=after-before;const explicit=input.signals.filter(x=>x.task_fingerprint===input.fingerprint&&x.explicit).length,confidence=Math.min(.99,.5+(input.before.length+input.after.length)*.04+explicit*.03);return{assessment:Math.abs(effect)<2?"inconclusive" as const:effect>0?"helpful" as const:"harmful" as const,reason:Math.abs(effect)<2?"effect_below_threshold":"comparable_fingerprint_cohort",confidence:Number(confidence.toFixed(3)),effect:Number(effect.toFixed(3)),signal_count:input.signals.filter(x=>x.task_fingerprint===input.fingerprint).length};
}
function normalizeIntent(value:string){return value.normalize("NFKC").toLowerCase().replace(/\b\d+\b/g,"#").replace(/\s+/g," ").trim()}
function stringValue(value:JsonValue|undefined){return typeof value==="string"?value:undefined}function stringArray(value:JsonValue|undefined){return Array.isArray(value)?value.filter((x):x is string=>typeof x==="string"):[]}function average(values:number[]){return values.reduce((a,b)=>a+b,0)/values.length}
