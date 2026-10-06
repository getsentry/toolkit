import { useInput } from "ink";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

const DEFAULT_SHORTCUT_PRIORITY = 100;

export type ShortcutHint = {
  key: string;
  action: string;
  priority?: number;
};

export type ShortcutBinding = ShortcutHint & {
  match: (input: string, key: InkKey) => boolean;
  run: (input: string, key: InkKey) => void;
  showInFooter?: boolean;
};

type ShortcutRegistry = {
  setScope: (scope: string, hints: ShortcutHint[]) => void;
  clearScope: (scope: string) => void;
};

const ShortcutRegistryContext = createContext<ShortcutRegistry | null>(null);
const ShortcutHintsContext = createContext<ShortcutHint[]>([]);

function shortcutPriority(hint: ShortcutHint): number {
  return hint.priority ?? DEFAULT_SHORTCUT_PRIORITY;
}

function shortcutKey(hint: ShortcutHint): string {
  return `${hint.key}\u0000${hint.action}`;
}

function shortcutSignature(hints: readonly ShortcutHint[]): string {
  return hints
    .map((hint) => `${shortcutPriority(hint)}:${hint.key}:${hint.action}`)
    .join("\n");
}

export function arrangeShortcutHints(
  hints: readonly ShortcutHint[]
): ShortcutHint[] {
  const seen = new Set<string>();
  const unique: Array<{ hint: ShortcutHint; index: number }> = [];

  for (const hint of hints) {
    const key = shortcutKey(hint);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ hint, index: unique.length });
  }

  unique.sort((left, right) => {
    const priorityDelta =
      shortcutPriority(left.hint) - shortcutPriority(right.hint);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.index - right.index;
  });

  return unique.map(({ hint }) => hint);
}

export function ShortcutHintProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactNode {
  const scopes = useRef(new Map<string, ShortcutHint[]>());
  const signature = useRef("");
  const [hints, setHints] = useState<ShortcutHint[]>([]);

  const refresh = useCallback(() => {
    const allHints: ShortcutHint[] = [];
    for (const scopedHints of scopes.current.values()) {
      allHints.push(...scopedHints);
    }
    const nextHints = arrangeShortcutHints(allHints);
    const nextSignature = shortcutSignature(nextHints);
    if (nextSignature === signature.current) {
      return;
    }
    signature.current = nextSignature;
    setHints(nextHints);
  }, []);

  const setScope = useCallback(
    (scope: string, scopedHints: ShortcutHint[]) => {
      if (scopedHints.length === 0) {
        scopes.current.delete(scope);
      } else {
        scopes.current.set(scope, scopedHints);
      }
      refresh();
    },
    [refresh]
  );

  const clearScope = useCallback(
    (scope: string) => {
      scopes.current.delete(scope);
      refresh();
    },
    [refresh]
  );

  const registry = useMemo(
    () => ({ setScope, clearScope }),
    [setScope, clearScope]
  );

  return (
    <ShortcutRegistryContext.Provider value={registry}>
      <ShortcutHintsContext.Provider value={hints}>
        {children}
      </ShortcutHintsContext.Provider>
    </ShortcutRegistryContext.Provider>
  );
}

export function useShortcutHints(): ShortcutHint[] {
  return useContext(ShortcutHintsContext);
}

export function useInkShortcuts(
  scope: string,
  bindings: readonly ShortcutBinding[],
  options: { isActive?: boolean } = {}
): void {
  const registry = useContext(ShortcutRegistryContext);
  const isActive = options.isActive ?? true;

  const footerHints = useMemo(() => {
    if (!isActive) {
      return [];
    }
    return bindings
      .filter((binding) => binding.showInFooter !== false)
      .map(({ key, action, priority }) => ({ key, action, priority }));
  }, [bindings, isActive]);

  useEffect(() => {
    if (!registry) {
      return;
    }
    registry.setScope(scope, footerHints);
    return () => {
      registry.clearScope(scope);
    };
  }, [registry, scope, footerHints]);

  useInput(
    (input, key) => {
      for (const binding of bindings) {
        if (binding.match(input, key)) {
          binding.run(input, key);
          return;
        }
      }
    },
    { isActive }
  );
}
