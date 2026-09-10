import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createNativeDraftNavigationController,
  type NativeDraftNavigationController
} from "./use-native-draft-navigation";
import { NativeDraftNavigationPrompt } from "./NativeDraftNavigationPrompt";

function promptMarkup(controller: NativeDraftNavigationController): string {
  return renderToStaticMarkup(createElement(NativeDraftNavigationPrompt, { controller }));
}

describe("Native draft navigation controller", () => {
  it("does not leave during a delayed save, then offers the common three choices", async () => {
    let resolveSave: ((result: boolean) => void) | undefined;
    let moved = false;
    const controller = createNativeDraftNavigationController({
      scopeKey: "connection-a\nworkspace-a\nroom-a\nsurface",
      label: "成果物",
      dirty: true,
      saving: true,
      save: () => new Promise<boolean>((resolve) => { resolveSave = resolve; }),
      discard: () => undefined
    });

    expect(controller.requestNavigation(() => { moved = true; })).toBe(false);
    expect(controller.getState().phase).toBe("saving");
    expect(moved).toBe(false);
    expect(promptMarkup(controller)).toContain("保存中です");
    expect(promptMarkup(controller)).toContain("保存して移動");
    expect(promptMarkup(controller)).toContain("破棄して移動");
    expect(promptMarkup(controller)).toContain("キャンセル");

    controller.updateState({
      scopeKey: controller.scopeKey,
      label: "成果物",
      dirty: true,
      saving: false
    });
    const savePromise = controller.saveAndNavigate();
    expect(controller.getState().phase).toBe("saving");
    expect(moved).toBe(false);

    resolveSave?.(true);
    controller.updateState({
      scopeKey: controller.scopeKey,
      label: "成果物",
      dirty: false,
      saving: false
    });
    await expect(savePromise).resolves.toBe(true);
    expect(moved).toBe(true);
  });

  it("keeps a failed save pending and allows retry or discard", async () => {
    let shouldSucceed = false;
    let discarded = false;
    let moved = false;
    let controller: NativeDraftNavigationController;
    controller = createNativeDraftNavigationController({
      scopeKey: "room-a\nsettings",
      label: "設定",
      dirty: true,
      saving: false,
      save: () => {
        if (!shouldSucceed) return false;
        controller.updateState({
          scopeKey: controller.scopeKey,
          label: "設定",
          dirty: false,
          saving: false
        });
        return true;
      },
      discard: () => { discarded = true; }
    });

    expect(controller.requestNavigation(() => { moved = true; })).toBe(false);
    await expect(controller.saveAndNavigate()).resolves.toBe(false);
    expect(controller.getState().phase).toBe("save_failed");
    expect(moved).toBe(false);

    shouldSucceed = true;
    await expect(controller.saveAndNavigate()).resolves.toBe(true);
    expect(moved).toBe(true);

    discarded = false;
    moved = false;
    controller.updateState({
      scopeKey: controller.scopeKey,
      label: "設定",
      dirty: true,
      saving: false
    });
    expect(controller.requestNavigation(() => { moved = true; })).toBe(false);
    expect(controller.discardAndNavigate()).toBe(true);
    expect(discarded).toBe(true);
    expect(moved).toBe(true);
  });

  it("does not let another scope's saving state block navigation", () => {
    let moved = false;
    const savingController = createNativeDraftNavigationController({
      scopeKey: "room-a\nsurface",
      label: "成果物",
      dirty: true,
      saving: true
    });
    const unrelatedController = createNativeDraftNavigationController({
      scopeKey: "room-b\nsettings",
      label: "設定",
      dirty: false,
      saving: false
    });

    expect(savingController.getState().phase).toBe("saving");
    expect(unrelatedController.requestNavigation(() => { moved = true; })).toBe(true);
    expect(moved).toBe(true);
  });
});
