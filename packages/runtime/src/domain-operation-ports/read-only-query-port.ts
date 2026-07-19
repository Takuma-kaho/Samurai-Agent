import { domainQueryReadCapability, type ReadCapability } from "@samurai-agent/domain-operations";

type ReadOnlyQueryPort<T extends object> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? ReadCapability<(...args: A) => R>
    : T[K];
} & { readonly [domainQueryReadCapability]: true };

type UnbrandedQueryPort<T extends object> = {
  [K in keyof T as K extends symbol ? never : K]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : T[K];
};

export function readOnlyQueryFunction<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
): ReadCapability<(...args: Args) => Result> {
  return Object.assign((...args: Args) => fn(...args), { [domainQueryReadCapability]: true as const });
}

export function readOnlyQueryPort<Expected extends object>(port: UnbrandedQueryPort<Expected>): ReadOnlyQueryPort<Expected> {
  const branded = Object.fromEntries(Object.entries(port).map(([key, value]) => [
    key,
    typeof value === "function"
      ? Object.assign((...args: never[]) => Reflect.apply(value, undefined, args), { [domainQueryReadCapability]: true as const })
      : value
  ]));
  return Object.freeze(Object.assign(branded, { [domainQueryReadCapability]: true as const })) as ReadOnlyQueryPort<Expected>;
}
