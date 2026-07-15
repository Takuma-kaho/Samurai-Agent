import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "browser.download_to_workspace" | "browser.interact" | "browser.navigate" | "browser.screenshot" | "browser.extract">;

export function createBrowserDomainServicePorts(services: Pick<RuntimeDomainServices, "browserDomainService">): Ports {
  return {
    "browser.download_to_workspace": {
      executeBrowserDownloadToWorkspace: async (context, input) => ({
        ok: true as const,
        value: await services.browserDomainService.downloadToWorkspace(input)
      })
    },
    "browser.interact": {
      executeBrowserInteract: async (context, input) => ({
        ok: true as const,
        value: await services.browserDomainService.interact(input)
      })
    },
    "browser.navigate": {
      executeBrowserNavigate: async (context, input) => ({
        ok: true as const,
        value: await services.browserDomainService.navigate(input)
      })
    },
    "browser.screenshot": {
      executeBrowserScreenshot: async (context, input) => ({
        ok: true as const,
        value: await services.browserDomainService.screenshot(input)
      })
    },
    "browser.extract": {
      executeBrowserExtract: async (context, input) => ({
        ok: true as const,
        value: await services.browserDomainService.extract(input)
      })
    }
  };
}

