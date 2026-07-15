import {
  getDomainCommandForSurfaceOperationKind,
  getDomainQueryEntry,
  getDomainQueryForSurfaceOperationKind,
  requireDomainCommandEntry,
  type DomainCommandEntry,
  type DomainCommandOutputRenderKind,
  type DomainQueryEntry
} from "@samurai-agent/action-catalog";
import type { ArtifactKind } from "@samurai-agent/artifacts";
import type {
  SurfaceOperation,
  SurfaceOperationDispatchPlan,
  SurfaceOperationResultKind,
  SurfaceRenderKind
} from "@samurai-agent/ui-protocol";

type StructuredSurfaceOperation = Extract<SurfaceOperation, {
  kind: "form.submit" | "table.patch" | "chart.request" | "artifact.request" | "custom_view.action";
}>;

export function commandIdForSurfaceOperation(kind: SurfaceOperation["kind"]): string {
  const command = getDomainCommandForSurfaceOperationKind(kind);
  if (!command) throw new Error(`surface_command_mapping_missing:${kind}`);
  return command.id;
}

export function queryIdForSurfaceOperation(kind: SurfaceOperation["kind"]): string {
  const query = getDomainQueryForSurfaceOperationKind(kind);
  if (!query) throw new Error(`surface_query_mapping_missing:${kind}`);
  return query.id;
}

export function isCollectionRecordCreateSurface(operation: SurfaceOperation): operation is Extract<SurfaceOperation, { kind: "collection.record.create" }> {
  return operation.kind === "collection.record.create";
}

export function isCollectionViewPresentSurface(operation: SurfaceOperation): operation is Extract<SurfaceOperation, { kind: "collection.view.present" }> {
  return operation.kind === "collection.view.present";
}

export function isMessagePresentationUpdateSurface(operation: SurfaceOperation): operation is Extract<SurfaceOperation, { kind: "message.presentation.update" }> {
  return operation.kind === "message.presentation.update";
}

export function isCollectionRecordDeleteSurface(operation: SurfaceOperation): operation is Extract<SurfaceOperation, { kind: "collection.record.delete" }> {
  return operation.kind === "collection.record.delete";
}

export function isCollectionActionRunSurface(operation: SurfaceOperation): operation is Extract<SurfaceOperation, { kind: "collection.action.run" }> {
  return operation.kind === "collection.action.run";
}

export function isCollectionSchemaSaveOperation<T extends { operation: string; result_ref?: { kind: string } }>(
  operation: T
): operation is T & { result_ref: { kind: "collection_schema"; id: string } } {
  return operation.operation === "collection.schema.save" && operation.result_ref?.kind === "collection_schema";
}

function commandRenderKind(command: DomainCommandEntry, renderKind: SurfaceRenderKind): SurfaceRenderKind {
  if (!command.output_render_kinds.includes(renderKind as DomainCommandOutputRenderKind)) {
    throw new Error(`Domain command ${command.id} does not declare render kind: ${renderKind}`);
  }
  return renderKind;
}

function queryRenderKind(query: DomainQueryEntry, renderKind: SurfaceRenderKind): SurfaceRenderKind {
  if (!query.output_render_kinds.includes(renderKind as DomainCommandOutputRenderKind)) {
    throw new Error(`Domain query ${query.id} does not declare render kind: ${renderKind}`);
  }
  return renderKind;
}

export function planSurfaceOperationDispatch(operation: SurfaceOperation): SurfaceOperationDispatchPlan {
  if (operation.kind === "message.submit") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("chat.turn.run");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "host_chat",
      runtimeMethod: "runDomainCommand",
      operationName: command.id,
      resultKind: "chat_turn",
      renderKind: commandRenderKind(command, "chat"),
      requiresSession: true,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.record.create") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.record.create");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: "runDomainCommand",
      operationName: command.id,
      resultKind: "collection_record",
      renderKind: commandRenderKind(command, "collection_record"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.view.present") {
    const query = getDomainQueryForSurfaceOperationKind(operation.kind) ?? getDomainQueryEntry("collection.view.present")!;
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: "runDomainQuery",
      operationName: query.id,
      resultKind: "collection_view",
      renderKind: queryRenderKind(query, "custom_view"),
      requiresSession: false,
      writesWorkspace: false,
      outputResourceKind: query.output_resource_kind,
      proposedEffects: query.proposed_effects
    });
  }
  if (operation.kind === "collection.record.patch") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.patch.apply");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: "runDomainCommand",
      operationName: command.id,
      resultKind: "collection_patch",
      renderKind: commandRenderKind(command, "collection_record"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.record.delete") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.record.delete");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: "runDomainCommand",
      operationName: command.id,
      resultKind: "collection_delete",
      renderKind: commandRenderKind(command, "custom_view"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  if (operation.kind === "collection.action.run") {
    const command = getDomainCommandForSurfaceOperationKind(operation.kind) ?? requireDomainCommandEntry("collection.action.run");
    return surfaceDispatchPlan(operation, {
      dispatchTarget: "collection_engine",
      runtimeMethod: "runDomainCommand",
      operationName: command.id,
      resultKind: "collection_action",
      renderKind: commandRenderKind(command, "custom_view"),
      requiresSession: false,
      writesWorkspace: command.writes_workspace,
      outputResourceKind: command.output_resource_kind,
      proposedEffects: command.proposed_effects
    });
  }
  const structuredOperation = operation as StructuredSurfaceOperation;
  const command = getDomainCommandForSurfaceOperationKind(structuredOperation.kind) ?? requireDomainCommandEntry("artifact.create");
  return surfaceDispatchPlan(structuredOperation, {
    dispatchTarget: "artifact_pipeline",
    runtimeMethod: "runDomainCommand",
    operationName: command.id,
    resultKind: surfaceOperationResultKind(structuredOperation),
    renderKind: commandRenderKind(command, surfaceOperationRenderKind(structuredOperation)),
    requiresSession: true,
    writesWorkspace: command.writes_workspace,
    outputResourceKind: surfaceOperationArtifactKind(structuredOperation),
    proposedEffects: [surfaceOperationEffect(structuredOperation)]
  });
}

export function surfaceOperationResultKind(operation: StructuredSurfaceOperation): SurfaceOperationResultKind {
  if (operation.kind === "form.submit") {
    return "form_submission";
  }
  if (operation.kind === "table.patch") {
    return "table_patch";
  }
  if (operation.kind === "chart.request") {
    return "chart_request";
  }
  if (operation.kind === "custom_view.action") {
    return "custom_view_action";
  }
  return "artifact";
}

function surfaceOperationRenderKind(operation: StructuredSurfaceOperation): SurfaceRenderKind {
  if (operation.kind === "form.submit") {
    return "form";
  }
  if (operation.kind === "table.patch") {
    return "table";
  }
  if (operation.kind === "chart.request") {
    return "chart";
  }
  if (operation.kind === "custom_view.action") {
    return "custom_view";
  }
  return "artifact";
}

function surfaceDispatchPlan(operation: SurfaceOperation, input: {
  dispatchTarget: SurfaceOperationDispatchPlan["dispatch_target"];
  runtimeMethod: string;
  operationName: string;
  resultKind: SurfaceOperationResultKind;
  renderKind: SurfaceRenderKind;
  requiresSession: boolean;
  writesWorkspace: boolean;
  outputResourceKind: string;
  proposedEffects: string[];
}): SurfaceOperationDispatchPlan {
  return {
    operation_id: operation.id,
    operation_kind: operation.kind,
    dispatch_target: input.dispatchTarget,
    runtime_method: input.runtimeMethod,
    operation_name: input.operationName,
    result_kind: input.resultKind,
    render_kind: input.renderKind,
    requires_session: input.requiresSession,
    writes_workspace: input.writesWorkspace,
    output_resource_kind: input.outputResourceKind,
    proposed_effects: input.proposedEffects
  };
}

export function surfaceOperationEffect(operation: StructuredSurfaceOperation): string {
  if (operation.kind === "form.submit") {
    return `Persist submitted form ${operation.form_id} as a local structured artifact.`;
  }
  if (operation.kind === "table.patch") {
    return `Persist table patch ${operation.table_id} as a local table artifact.`;
  }
  if (operation.kind === "chart.request") {
    return `Persist chart request ${operation.chart_id ?? operation.title} as a local chart artifact.`;
  }
  if (operation.kind === "custom_view.action") {
    return `Persist custom view action ${operation.view_id}/${operation.action_id} as a local structured artifact.`;
  }
  return `Persist artifact ${operation.action} request as a local artifact.`;
}

export function surfaceOperationArtifactKind(operation: StructuredSurfaceOperation): ArtifactKind {
  if (operation.kind === "table.patch") {
    return "table";
  }
  if (operation.kind === "chart.request") {
    return "chart";
  }
  if (operation.kind === "artifact.request" && operation.action === "export") {
    return "generated_report";
  }
  if (operation.kind === "artifact.request" && operation.action === "preview") {
    return "note";
  }
  if (operation.kind === "artifact.request") {
    return "document";
  }
  return "structured_draft";
}
