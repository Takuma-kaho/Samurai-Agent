import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "browser.download_to_workspace" | "browser.interact" | "browser.navigate" | "browser.screenshot" | "browser.extract">;

export function createBrowserDomainServicePorts(services: Pick<RuntimeDomainServices, "browserDomainService">): Ports {
  return {
    "browser.download_to_workspace": {
      readBrowserPage: (url) => services.browserDomainService.readPage(url),
      ensureBrowserSession: () => services.browserDomainService.ensureSession(),
      createBrowserEnvelope: (session, content) => services.browserDomainService.createEnvelope(session, content),
      stableBrowserHash: (value) => services.browserDomainService.stableHash(value),
      resolveBrowserWorkspacePath: (path) => services.browserDomainService.resolveWorkspacePath(path),
      ensureBrowserWorkspaceParent: (path) => services.browserDomainService.ensureWorkspaceParent(path),
      readBrowserWorkspaceText: (path) => services.browserDomainService.readWorkspaceTextIfExists(path),
      writeBrowserWorkspaceFile: (path, content) => services.browserDomainService.writeWorkspaceFile(path, content),
      createBrowserRollback: (operation, refs, before, after) => services.browserDomainService.createBrowserRollback(operation, refs, before, after),
      runBrowserMutation: (input) => services.browserDomainService.runRecordedMutation(input)
    },
    "browser.interact": {
      interactWithBrowser: (input) => services.browserDomainService.interactPage(input),
      ensureBrowserSession: () => services.browserDomainService.ensureSession(),
      createBrowserEnvelope: (session, content) => services.browserDomainService.createEnvelope(session, content),
      stableBrowserHash: (value) => services.browserDomainService.stableHash(value),
      runBrowserMutation: (input) => services.browserDomainService.runRecordedMutation(input)
    },
    "browser.navigate": {
      readBrowserPage: (url) => services.browserDomainService.readPage(url),
      ensureBrowserSession: () => services.browserDomainService.ensureSession(),
      createBrowserEnvelope: (session, content) => services.browserDomainService.createEnvelope(session, content),
      stableBrowserHash: (value) => services.browserDomainService.stableHash(value),
      runBrowserMutation: (input) => services.browserDomainService.runRecordedMutation(input)
    },
    "browser.screenshot": {
      captureBrowserScreenshot: (url) => services.browserDomainService.captureScreenshot(url),
      ensureBrowserSession: () => services.browserDomainService.ensureSession(),
      createBrowserEnvelope: (session, content) => services.browserDomainService.createEnvelope(session, content),
      stableBrowserHash: (value) => services.browserDomainService.stableHash(value),
      browserBytesToBase64: (bytes) => services.browserDomainService.browserBytesToBase64(bytes),
      resolveBrowserWorkspacePath: (path) => services.browserDomainService.resolveWorkspacePath(path),
      ensureBrowserWorkspaceParent: (path) => services.browserDomainService.ensureWorkspaceParent(path),
      readBrowserWorkspaceBytes: (path) => services.browserDomainService.readWorkspaceBytesIfExists(path),
      writeBrowserWorkspaceFile: (path, content) => services.browserDomainService.writeWorkspaceFile(path, content),
      createBrowserRollback: (operation, refs, before, after) => services.browserDomainService.createBrowserRollback(operation, refs, before, after),
      runBrowserMutation: (input) => services.browserDomainService.runRecordedMutation(input)
    },
    "browser.extract": readOnlyQueryPort<Ports["browser.extract"]>({
      extractBrowserPage: (input) => services.browserDomainService.extract(input)
    })
  };
}
