import type { DeepReadonly } from "../public.ts";

/** Copies the graph before freezing it; Map/Set mutation methods never expose the backing collection. */
export function readonlyCopy<T>(input: T): DeepReadonly<T> {
  const copies = new WeakMap<object, unknown>();
  const pending: (() => void)[] = [];
  function copy(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (copies.has(value)) return copies.get(value);
    if (value instanceof Map || value instanceof Set) {
      const target = value instanceof Map ? new Map() : new Set();
      const proxy = new Proxy(target, {
        get(collection, key) {
          if (["set", "add", "delete", "clear"].includes(String(key)))
            return () => {
              throw new TypeError("Telemetry snapshots are read-only");
            };
          if (key === "valueOf") return () => proxy;
          if (key === "forEach")
            return (
              callback: (
                value: unknown,
                key: unknown,
                collection: unknown,
              ) => void,
              thisArg?: unknown,
            ) => {
              collection.forEach((item, itemKey) =>
                callback.call(thisArg, item, itemKey, proxy),
              );
            };
          const member = Reflect.get(collection, key, collection);
          return typeof member === "function" &&
            (["get", "has", "entries", "keys", "values"].includes(
              String(key),
            ) ||
              key === Symbol.iterator)
            ? member.bind(collection)
            : member;
        },
        setPrototypeOf() {
          throw new TypeError("Telemetry snapshots are read-only");
        },
        set() {
          throw new TypeError("Telemetry snapshots are read-only");
        },
        defineProperty() {
          throw new TypeError("Telemetry snapshots are read-only");
        },
        deleteProperty() {
          throw new TypeError("Telemetry snapshots are read-only");
        },
      });
      copies.set(value, proxy);
      pending.push(() => {
        if (value instanceof Map && target instanceof Map)
          for (const [key, item] of value) target.set(copy(key), copy(item));
        else if (value instanceof Set && target instanceof Set)
          for (const item of value) target.add(copy(item));
      });
      return proxy;
    }
    const result: Record<PropertyKey, unknown> | unknown[] = Array.isArray(
      value,
    )
      ? []
      : {};
    copies.set(value, result);
    pending.push(() => {
      for (const key of Object.keys(value))
        Object.defineProperty(result, key, {
          value: copy((value as Record<string, unknown>)[key]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      Object.freeze(result);
    });
    return result;
  }
  const result = copy(input);
  // Allocate each node once, then fill it from a worklist instead of the call stack.
  for (let next = pending.pop(); next; next = pending.pop()) next();
  return result as DeepReadonly<T>;
}
