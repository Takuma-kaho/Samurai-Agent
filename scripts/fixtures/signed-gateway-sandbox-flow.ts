import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifySignedWebhook } from "../../apps/server/src/middleware/security";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import { createDefaultGatewayBoundaryPolicy, createDefaultGatewayPairingPolicy, executeSandboxCommand, type SandboxCommandAdapter } from "../../packages/gateway/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
const secret="fixture-webhook-secret",timestamp="1767225600",body=Buffer.from('{"message":"run"}'),signature=createHmac("sha256",secret).update(`${timestamp}.`).update(body).digest("hex");
assert.equal(verifySignedWebhook({secret,timestamp,signature,body,now:Number(timestamp)*1000}).ok,true);assert.equal(verifySignedWebhook({secret,timestamp,signature:`0${signature.slice(1)}`,body,now:Number(timestamp)*1000}).ok,false);
const root=await mkdtemp(path.join(tmpdir(),"samurai-signed-gateway-")),store=await WorkspaceStore.create({rootDir:root});
const backend:AgentBackend={id:"fixture",kind:"samurai_native",label:"fixture",sessionPolicy:{acquisition:"none",resume:"unsupported"},execution_owner:"host",async*runTurn(){yield{event_type:"text_delta",payload:{text:"sandbox reply"}};yield{event_type:"run_completed",payload:{output_summary:"sandbox reply"}}}};
const runtime=new AgentRuntime(store,()=>undefined,undefined,new AgentBackendRegistry([backend]));
try{
  const policy=createDefaultGatewayBoundaryPolicy({source_channel:"webhook",session_key:"webhook:signed:main",allowed_tools:["sandbox.exec"]});policy.sandbox={...policy.sandbox,mode:"all",backend:"docker",workspace_access:"read_write",network_access:"none",metadata:{docker_image:"alpine:3.20"}};
  let observedBackend="";const adapter:SandboxCommandAdapter={execute:async input=>{observedBackend=input.sandbox.backend;return{exit_code:0,stdout:"sandbox-ok",stderr:"",resource_refs:[{kind:"file",id:"sandbox-output",uri:"outputs/sandbox.txt"}]}}};
  const sandbox=await executeSandboxCommand(policy,{command:"sh",args:["-lc","printf sandbox-ok"]},adapter,{workspaceRoot:root});assert.equal(sandbox.status,"completed");assert.equal(observedBackend,"docker");
  await runtime.saveGatewayPairingPolicy({...createDefaultGatewayPairingPolicy("webhook"),trust_mode:"auto_approve"});
  const inbound=await runtime.handleGatewayInbound({channel:"webhook",source_identity:"signed-source",body:"Run signed sandbox request",backend_id:backend.id,metadata:{message_id:"signed-message",signature_status:"verified",sandbox_backend:"docker"}});assert.equal(inbound.inbound.status,"blocked");assert.equal(inbound.inbound.error,"gateway_participant_authentication_required");assert.equal(inbound.session,undefined);assert.equal(inbound.chat,undefined);assert.equal(inbound.boundaryPolicy,undefined);
  const delivery=await store.enqueueGatewayDelivery({id:"signed-reply",inbound_id:inbound.inbound.id,session_key:"webhook:signed:main",channel:"webhook",status:"pending",idempotency_key:"reply:signed-message",payload:{text:"sandbox reply",sandbox_stdout:sandbox.stdout??""},attempt:0,max_attempts:3,created_at:new Date(0).toISOString(),updated_at:new Date(0).toISOString()});
  await store.claimGatewayDelivery(delivery.id,{now:new Date(0).toISOString(),leaseUntil:new Date(60000).toISOString()});await store.completeGatewayDelivery(delivery.id,{now:new Date(1).toISOString(),receipt:{status:200}});
  assert.equal((await store.getGatewayDelivery(delivery.id))?.status,"delivered");
  process.stdout.write(`${JSON.stringify({status:"passed",signature_verified:true,invalid_signature_rejected:true,docker_policy_executed:true,real_docker_executed:false,domain_command_executions:(await store.listDomainCommandExecutions()).filter(x=>x.command_id==="gateway.inbound.route").length,workspace_inbound_saved:(await store.listGatewayInboundMessages()).length,metadata_does_not_grant_room_access:true,session_saved:false,reply_delivered:true})}\n`);
}finally{await runtime.shutdownMcpProcessPool().catch(()=>undefined);await store.close();await rm(root,{recursive:true,force:true})}
