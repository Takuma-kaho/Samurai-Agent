export interface TimeboxedContextValue<T> {
  value: T;
  timedOut: boolean;
  step: string;
}

export const contextStepTimeoutMs = 2_000;

export function timeboxContextValue<T>(value: T, timedOut: boolean, step = "context"): TimeboxedContextValue<T> {
  return { value, timedOut, step };
}

export function timeboxContextStep<T>(promise: Promise<T>, fallback: T, step: string): Promise<TimeboxedContextValue<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeboxedContextValue<T>>((resolve) => {
    timer = setTimeout(() => resolve(timeboxContextValue(fallback, true, step)), contextStepTimeoutMs);
  });
  return Promise.race([
    promise.then((value) => timeboxContextValue(value, false, step)).catch(() => timeboxContextValue(fallback, true, step)),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
