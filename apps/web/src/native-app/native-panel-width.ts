export interface NativePanelWidthTransitionConfig {
  minWidth: number;
  closeDragDistance: number;
  maxWidth?: number;
  expandDragDistance?: number;
  clampWidth: (width: number) => number;
}

export type NativePanelWidthTransition =
  | { kind: "close" }
  | { kind: "expand"; restoreWidth: number }
  | { kind: "split"; width: number };

/**
 * Keep the visible panel at its boundary until the user deliberately moves
 * past the extra drag distance. The same raw pointer position can therefore
 * move back across the boundary without destroying the active drag.
 */
export function nativePanelWidthTransition(
  currentWidth: number,
  nextWidth: number,
  config: NativePanelWidthTransitionConfig
): NativePanelWidthTransition {
  const proposed = Number.isFinite(nextWidth) ? Math.round(nextWidth) : Math.round(currentWidth);
  const maximum = config.maxWidth;
  if (proposed < config.minWidth - config.closeDragDistance) return { kind: "close" };
  if (maximum !== undefined && maximum >= config.minWidth && config.expandDragDistance !== undefined
    && proposed > maximum + config.expandDragDistance) {
    return { kind: "expand", restoreWidth: config.clampWidth(currentWidth) };
  }
  return { kind: "split", width: config.clampWidth(proposed) };
}

export function nativePanelEdgeTransition(
  dragDistance: number,
  threshold: number
): "closed" | "open" {
  return Number.isFinite(dragDistance) && dragDistance >= threshold ? "open" : "closed";
}
