import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "artifact.create" | "artifact.export_pdf" | "artifact.repair" | "artifact.restore_revision" | "artifact.revise" | "graph.create" | "graph.patch" | "image.edit" | "image.generate">;

export function createArtifactDomainServicePorts(services: Pick<RuntimeDomainServices, "artifactDomainService">): Ports {
  return {
    "artifact.create": {
      artifactContract: (id) => services.artifactDomainService.contract(id), createArtifactSession: (input) => services.artifactDomainService.createArtifactSession(input),
      getArtifactSession: (id) => services.artifactDomainService.getArtifactSession(id), artifactSessionNotFoundError: () => services.artifactDomainService.artifactSessionNotFoundError(),
      validateGraphArtifactContent: (content) => services.artifactDomainService.validateGraphContent(content),
      createArtifactEnvelope: (session, content, inputLocale, outputLocale, metadata, envelopeId) => services.artifactDomainService.createArtifactEnvelope(session, content, inputLocale, outputLocale, metadata, envelopeId),
      createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.export_pdf": {
      artifactContract: (id) => services.artifactDomainService.contract(id), getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      readArtifactContent: (id) => services.artifactDomainService.readArtifactContent(id), exportArtifactPdf: (input) => services.artifactDomainService.exportArtifactPdf(input),
      artifactNotFoundError: () => services.artifactDomainService.artifactNotFoundError(), artifactPdfSourceNotTextError: () => services.artifactDomainService.artifactPdfSourceNotTextError(),
      artifactPdfInvalidResultError: () => services.artifactDomainService.artifactPdfInvalidResultError(), ensureArtifactSession: () => services.artifactDomainService.ensureArtifactSession(),
      createArtifactEnvelope: (session, content) => services.artifactDomainService.createArtifactEnvelope(session, content), createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.repair": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      ensureArtifactSession: () => services.artifactDomainService.ensureArtifactSession(),
      createArtifactEnvelope: (session, content) => services.artifactDomainService.createArtifactEnvelope(session, content),
      repairArtifactRevisionSource: (id) => services.artifactDomainService.repairRevisionSource(id),
      artifactNotFoundError: () => services.artifactDomainService.artifactNotFoundError(),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.restore_revision": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      getArtifactRevision: (id) => services.artifactDomainService.getRevision(id),
      readArtifactRevisionContent: (id) => services.artifactDomainService.readRevisionContent(id),
      ensureArtifactSession: () => services.artifactDomainService.ensureArtifactSession(), createArtifactEnvelope: (session, content) => services.artifactDomainService.createArtifactEnvelope(session, content),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      artifactRevisionNotFoundError: () => services.artifactDomainService.artifactRevisionNotFoundError(),
      artifactRevisionContentNotFoundError: () => services.artifactDomainService.artifactRevisionContentNotFoundError(),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "artifact.revise": {
      artifactContract: (id) => services.artifactDomainService.contract(id), getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      artifactNotFoundError: () => services.artifactDomainService.artifactNotFoundError(),
      getArtifactSession: (id) => services.artifactDomainService.getArtifactSession(id), ensureArtifactSession: () => services.artifactDomainService.ensureArtifactSession(),
      artifactSessionNotFoundError: () => services.artifactDomainService.artifactSessionNotFoundError(), validateGraphArtifactContent: (content) => services.artifactDomainService.validateGraphContent(content),
      createArtifactEnvelope: (session, content) => services.artifactDomainService.createArtifactEnvelope(session, content),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "graph.create": {
      artifactContract: (id) => services.artifactDomainService.contract(id), validateGraphArtifactContent: (content) => services.artifactDomainService.validateGraphContent(content),
      createArtifactSession: (input) => services.artifactDomainService.createArtifactSession(input), getArtifactSession: (id) => services.artifactDomainService.getArtifactSession(id),
      artifactSessionNotFoundError: () => services.artifactDomainService.artifactSessionNotFoundError(),
      createArtifactEnvelope: (session, content, inputLocale, outputLocale, metadata, envelopeId) => services.artifactDomainService.createArtifactEnvelope(session, content, inputLocale, outputLocale, metadata, envelopeId),
      createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "graph.patch": {
      artifactContract: (id) => services.artifactDomainService.contract(id), getArtifact: (id) => services.artifactDomainService.getArtifact(id),
      readArtifactContent: (id) => services.artifactDomainService.readArtifactContent(id), graphArtifactNotFoundError: () => services.artifactDomainService.graphArtifactNotFoundError(),
      graphDocumentContentNotFoundError: () => services.artifactDomainService.graphDocumentContentNotFoundError(), graphDocumentInvalidError: () => services.artifactDomainService.graphDocumentInvalidError(),
      ensureArtifactSession: () => services.artifactDomainService.ensureArtifactSession(), createArtifactEnvelope: (session, content) => services.artifactDomainService.createArtifactEnvelope(session, content),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input), createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "image.edit": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      getArtifact: (id) => services.artifactDomainService.getArtifact(id), imageArtifactNotFoundError: () => services.artifactDomainService.imageArtifactNotFoundError(),
      ensureArtifactSession: () => services.artifactDomainService.ensureArtifactSession(), createArtifactEnvelope: (session, content) => services.artifactDomainService.createArtifactEnvelope(session, content),
      decodeImageBase64: (value) => services.artifactDomainService.decodeImageBase64(value),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    },
    "image.generate": {
      artifactContract: (id) => services.artifactDomainService.contract(id),
      ensureArtifactSession: () => services.artifactDomainService.ensureArtifactSession(), createArtifactEnvelope: (session, content) => services.artifactDomainService.createArtifactEnvelope(session, content),
      decodeImageBase64: (value) => services.artifactDomainService.decodeImageBase64(value),
      createArtifactDraft: (input) => services.artifactDomainService.createArtifactDraft(input),
      createArtifactRevision: (input) => services.artifactDomainService.createRevision(input),
      createArtifactRollback: (operation, refs, before, after) => services.artifactDomainService.createArtifactRollback(operation, refs, before, after),
      runArtifactMutation: (input) => services.artifactDomainService.runArtifactMutation(input)
    }
  };
}
