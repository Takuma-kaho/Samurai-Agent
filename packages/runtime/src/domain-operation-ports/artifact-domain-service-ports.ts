import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "artifact.create" | "artifact.export_pdf" | "artifact.list" | "artifact.repair" | "artifact.restore_revision" | "artifact.revise" | "artifact.view" | "graph.create" | "graph.patch" | "image.edit" | "image.generate">;

export function createArtifactDomainServicePorts(services: Pick<RuntimeDomainServices, "artifactDomainService">): Ports {
  return {
    "artifact.create": {
      artifactContract: (id) => services.artifactDomainService.contract(id), artifactDefaultLocales: () => services.artifactDomainService.artifactDefaultLocales(),
      validateGraphArtifactContent: (content) => services.artifactDomainService.validateGraphContent(content),
      createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.export_pdf": {
      artifactContract: (id) => services.artifactDomainService.contract(id), getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      readArtifactContent: (id) => services.artifactDomainService.readArtifactContent(id), exportArtifactPdf: (input) => services.artifactDomainService.exportArtifactPdf(input),
      artifactNotFoundError: () => services.artifactDomainService.artifactNotFoundError(), artifactPdfSourceNotTextError: () => services.artifactDomainService.artifactPdfSourceNotTextError(),
      artifactPdfInvalidResultError: () => services.artifactDomainService.artifactPdfInvalidResultError(), createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.list": readOnlyQueryPort<Ports["artifact.list"]>({ listArtifacts: () => services.artifactDomainService.listArtifacts() }),
    "artifact.repair": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      repairArtifactRevisionSource: (id) => services.artifactDomainService.repairRevisionSource(id),
      artifactNotFoundError: () => services.artifactDomainService.artifactNotFoundError(),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.restore_revision": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      getArtifactRevision: (id) => services.artifactDomainService.getRevision(id),
      readArtifactRevisionContent: (id) => services.artifactDomainService.readRevisionContent(id),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      artifactRevisionNotFoundError: () => services.artifactDomainService.artifactRevisionNotFoundError(),
      artifactRevisionContentNotFoundError: () => services.artifactDomainService.artifactRevisionContentNotFoundError(),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.revise": {
      artifactContract: (id) => services.artifactDomainService.contract(id), getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      artifactNotFoundError: () => services.artifactDomainService.artifactNotFoundError(),
      validateGraphArtifactContent: (content) => services.artifactDomainService.validateGraphContent(content),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.view": readOnlyQueryPort<Ports["artifact.view"]>({ viewArtifact: (context, id) => services.artifactDomainService.viewArtifact(id) }),
    "graph.create": {
      artifactContract: (id) => services.artifactDomainService.contract(id), validateGraphArtifactContent: (content) => services.artifactDomainService.validateGraphContent(content),
      artifactDefaultLocales: () => services.artifactDomainService.artifactDefaultLocales(),
      createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "graph.patch": {
      artifactContract: (id) => services.artifactDomainService.contract(id), getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      readArtifactContent: (id) => services.artifactDomainService.readArtifactContent(id), graphArtifactNotFoundError: () => services.artifactDomainService.graphArtifactNotFoundError(),
      graphDocumentContentNotFoundError: () => services.artifactDomainService.graphDocumentContentNotFoundError(), graphDocumentInvalidError: () => services.artifactDomainService.graphDocumentInvalidError(),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "image.edit": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      getArtifact: (id) => services.artifactDomainService.getArtifact(id), imageArtifactNotFoundError: () => services.artifactDomainService.imageArtifactNotFoundError(),
      decodeImageBase64: (value) => services.artifactDomainService.decodeImageBase64(value),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "image.generate": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      artifactDefaultLocales: () => services.artifactDomainService.artifactDefaultLocales(),
      decodeImageBase64: (value) => services.artifactDomainService.decodeImageBase64(value),
      createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    }
  };
}
