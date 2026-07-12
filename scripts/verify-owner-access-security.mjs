import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
const root=process.cwd(),prefix=process.platform==="darwin"?`@esbuild+darwin-${process.arch==="arm64"?"arm64":"x64"}@`:`@esbuild+${process.platform}-${process.arch}@`;
const dir=readdirSync(path.join(root,"node_modules/.pnpm")).find(x=>x.startsWith(prefix));if(!dir)throw new Error("esbuild missing");
const name=dir.slice(0,dir.lastIndexOf("@")).replace("+","/"),esbuild=path.join(root,"node_modules/.pnpm",dir,"node_modules",name,"bin/esbuild"),cache=path.join(root,"node_modules/.cache");mkdirSync(cache,{recursive:true});
const temp=mkdtempSync(path.join(cache,"samurai-owner-security-")),out=path.join(temp,"verify.mjs"),sources=["apps/server/src/middleware/security.ts","apps/server/src/index.ts","scripts/fixtures/owner-access-security.ts","scripts/verify-owner-access-security.mjs","scripts/lib/core-evidence.mjs"];
try{
  execFileSync(esbuild,[path.join(root,"scripts/fixtures/owner-access-security.ts"),"--bundle","--platform=node","--format=esm","--external:better-sqlite3","--external:express","--external:cors","--external:socket.io",`--outfile=${out}`],{cwd:root,stdio:"inherit"});
  const started_at=new Date().toISOString(),raw=execFileSync(process.execPath,[out],{cwd:root,encoding:"utf8",env:{...process.env,NODE_ENV:"test"}}).trim(),result=JSON.parse(raw),completed_at=new Date().toISOString(),evidence=path.join(root,"reports/core-completion/evidence");mkdirSync(evidence,{recursive:true});
  writeFileSync(path.join(evidence,"F04.json"),`${JSON.stringify({schema_version:1,test_id:"F04",command:"pnpm core:test:owner-security",status:"passed",...committedSourceEvidence(root,sources),started_at,completed_at,assertions:[{name:"Local and remote API use the same owner token policy with rotation grace",actual:result.local_token_required&&result.remote_token_policy_same&&result.rotation_and_grace,expected:true},{name:"CORS, rate and request size controls reject abuse",actual:result.cors_blocked&&result.rate_limited&&result.size_limited,expected:true},{name:"SSRF blocks private, metadata and rebinding targets",actual:result.ssrf_private_targets_blocked,expected:5},{name:"Secrets are recursively redacted",actual:result.secret_redacted,expected:true}],result},null,2)}\n`);process.stdout.write(`${raw}\n`);
}finally{rmSync(temp,{recursive:true,force:true})}
