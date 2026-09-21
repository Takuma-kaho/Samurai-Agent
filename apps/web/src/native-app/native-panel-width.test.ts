import { describe, expect, it } from "vitest";
import { nativePanelEdgeTransition, nativePanelWidthTransition } from "./native-panel-width";

describe("native panel boundary transitions", () => {
  const config = {
    minWidth: 220,
    closeDragDistance: 110,
    maxWidth: 720,
    expandDragDistance: 140,
    clampWidth: (width: number) => Math.min(720, Math.max(220, Math.round(width)))
  };

  it("clamps at the boundary and changes only after the extra drag", () => {
    expect(nativePanelWidthTransition(300, 220, config)).toEqual({ kind: "split", width: 220 });
    expect(nativePanelWidthTransition(300, 110, config)).toEqual({ kind: "split", width: 220 });
    expect(nativePanelWidthTransition(300, 109, config)).toEqual({ kind: "close" });
    expect(nativePanelWidthTransition(500, 860, config)).toEqual({ kind: "split", width: 720 });
    expect(nativePanelWidthTransition(500, 861, config)).toEqual({ kind: "expand", restoreWidth: 500 });
  });

  it("supports opening again from a persistent closed edge", () => {
    expect(nativePanelEdgeTransition(109, 110)).toBe("closed");
    expect(nativePanelEdgeTransition(110, 110)).toBe("open");
    expect(nativePanelEdgeTransition(130, 130)).toBe("open");
  });
});
