/**
 * Model-Based Tests for Pagination Cursor Stack
 *
 * Uses fast-check to generate random sequences of advance/clear/resolve
 * operations and verifies behavior against a simplified model of the
 * stack-based pagination system.
 *
 * Invariants tested:
 * - Stack grows on "next", shrinks (truncates) on back-then-forward
 * - Index tracks current page position
 * - hasPreviousPage reflects index > 0
 * - resolveCursor resolves keywords to correct stack entries or throws
 * - clearPaginationState removes all state
 * - Expired state is treated as absent
 */

// biome-ignore-all lint/suspicious/noMisplacedAssertion: Model-based testing uses expect() inside command classes, not directly in test() functions. This is the standard fast-check pattern for stateful testing.

import {
  type AsyncCommand,
  asyncModelRun,
  asyncProperty,
  commands,
  constantFrom,
  assert as fcAssert,
  property,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  advancePaginationState,
  clearPaginationState,
  getPaginationState,
  hasPreviousPage,
  resolveCursor,
} from "../../../src/lib/db/pagination.js";
import {
  createIsolatedDbContext,
  DEFAULT_NUM_RUNS,
} from "../../model-based/helpers.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Model representing expected pagination state for a single (command, context) pair.
 *
 * We track only one pair in the model since the composite-key independence
 * is tested separately with property-based tests below.
 */
type PaginationModel = {
  /** Current cursor stack, or null if no state exists. */
  stack: string[] | null;
  /** Current page index (0-based), or null if no state. */
  index: number | null;
};

type RealDb = Record<string, never>;

/** Fixed keys used throughout the model-based test. */
const CMD_KEY = "test-list";
const CTX_KEY = "org:test|sort:date";

function createEmptyModel(): PaginationModel {
  return { stack: null, index: null };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Advance with direction "next" and an optional nextCursor.
 * Models both initial setup (no prior state) and forward navigation.
 */
class AdvanceNextCommand implements AsyncCommand<PaginationModel, RealDb> {
  readonly nextCursor: string | undefined;

  constructor(nextCursor: string | undefined) {
    this.nextCursor = nextCursor;
  }

  /**
   * When state already exists, only advance "next" if there's a stored next
   * cursor at index+1. This matches real usage: commands call resolveCursor
   * before advancing, which throws if no next page exists.
   *
   * When no state exists (first page), always allow — this initialises the stack.
   */
  check(model: PaginationModel): boolean {
    if (model.stack === null) {
      return true;
    }
    // Can advance if the next slot in the stack is populated
    return model.index !== null && model.index + 1 < model.stack.length;
  }

  async run(model: PaginationModel, _real: RealDb): Promise<void> {
    advancePaginationState(CMD_KEY, CTX_KEY, "next", this.nextCursor);

    if (model.stack === null) {
      // First page: initialise
      model.stack = this.nextCursor ? ["", this.nextCursor] : [""];
      model.index = 0;
    } else {
      const newIndex = model.index! + 1;
      // Truncate beyond new position (back-then-forward)
      const stack = model.stack.slice(0, newIndex + 1);
      if (this.nextCursor) {
        stack[newIndex + 1] = this.nextCursor;
      }
      model.stack = stack;
      model.index = newIndex;
    }

    // Verify real state matches model
    const real = getPaginationState(CMD_KEY, CTX_KEY);
    expect(real).toBeDefined();
    expect(real!.stack).toEqual(model.stack);
    expect(real!.index).toBe(model.index!);
  }

  toString(): string {
    return `advance("next", ${this.nextCursor ? `"${this.nextCursor}"` : "undefined"})`;
  }
}

/**
 * Advance with direction "prev".
 * Only valid when state exists and index > 0.
 */
class AdvancePrevCommand implements AsyncCommand<PaginationModel, RealDb> {
  readonly nextCursor: string | undefined;

  constructor(nextCursor: string | undefined) {
    this.nextCursor = nextCursor;
  }

  /** Only run when we can actually go back. */
  check(model: PaginationModel): boolean {
    return model.stack !== null && model.index !== null && model.index > 0;
  }

  async run(model: PaginationModel, _real: RealDb): Promise<void> {
    advancePaginationState(CMD_KEY, CTX_KEY, "prev", this.nextCursor);

    const newIndex = Math.max(0, model.index! - 1);
    const stack = [...model.stack!];
    if (this.nextCursor) {
      stack[newIndex + 1] = this.nextCursor;
    }
    // Truncate beyond newIndex + 2 (or newIndex + 1 if no nextCursor)
    model.stack = stack.slice(0, this.nextCursor ? newIndex + 2 : newIndex + 1);
    model.index = newIndex;

    const real = getPaginationState(CMD_KEY, CTX_KEY);
    expect(real).toBeDefined();
    expect(real!.stack).toEqual(model.stack);
    expect(real!.index).toBe(model.index);
  }

  toString(): string {
    return `advance("prev", ${this.nextCursor ? `"${this.nextCursor}"` : "undefined"})`;
  }
}

/**
 * Advance with direction "first".
 * Only valid when state exists.
 */
class AdvanceFirstCommand implements AsyncCommand<PaginationModel, RealDb> {
  readonly nextCursor: string | undefined;

  constructor(nextCursor: string | undefined) {
    this.nextCursor = nextCursor;
  }

  check(model: PaginationModel): boolean {
    return model.stack !== null;
  }

  async run(model: PaginationModel, _real: RealDb): Promise<void> {
    advancePaginationState(CMD_KEY, CTX_KEY, "first", this.nextCursor);

    model.stack = this.nextCursor ? ["", this.nextCursor] : [""];
    model.index = 0;

    const real = getPaginationState(CMD_KEY, CTX_KEY);
    expect(real).toBeDefined();
    expect(real!.stack).toEqual(model.stack);
    expect(real!.index).toBe(model.index);
  }

  toString(): string {
    return `advance("first", ${this.nextCursor ? `"${this.nextCursor}"` : "undefined"})`;
  }
}

/** Clear pagination state. */
class ClearCommand implements AsyncCommand<PaginationModel, RealDb> {
  check = () => true;

  async run(model: PaginationModel, _real: RealDb): Promise<void> {
    clearPaginationState(CMD_KEY, CTX_KEY);

    model.stack = null;
    model.index = null;

    expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeUndefined();
  }

  toString = () => "clear()";
}

/** Verify getPaginationState matches model. */
class GetStateCommand implements AsyncCommand<PaginationModel, RealDb> {
  check = () => true;

  async run(model: PaginationModel, _real: RealDb): Promise<void> {
    const real = getPaginationState(CMD_KEY, CTX_KEY);

    if (model.stack === null) {
      expect(real).toBeUndefined();
    } else {
      expect(real).toBeDefined();
      expect(real!.stack).toEqual(model.stack);
      expect(real!.index).toBe(model.index!);
    }
  }

  toString = () => "getState()";
}

/** Verify hasPreviousPage matches model. */
class HasPrevCommand implements AsyncCommand<PaginationModel, RealDb> {
  check = () => true;

  async run(model: PaginationModel, _real: RealDb): Promise<void> {
    const real = hasPreviousPage(CMD_KEY, CTX_KEY);
    const expected =
      model.stack !== null && model.index !== null && model.index > 0;
    expect(real).toBe(expected);
  }

  toString = () => "hasPreviousPage()";
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const cursorArb = constantFrom(
  "1735689600000:0:0",
  "1735689600000:100:0",
  "1735689600000:200:0",
  "1735689600000:300:0",
  "9999999999999:50:1"
);

const optionalCursorArb = constantFrom(
  "1735689600000:0:0",
  "1735689600000:100:0",
  "1735689600000:200:0",
  undefined
);

const advanceNextCmdArb = optionalCursorArb.map(
  (cur) => new AdvanceNextCommand(cur)
);

const advancePrevCmdArb = optionalCursorArb.map(
  (cur) => new AdvancePrevCommand(cur)
);

const advanceFirstCmdArb = optionalCursorArb.map(
  (cur) => new AdvanceFirstCommand(cur)
);

const clearCmdArb = constantFrom(new ClearCommand());
const getStateCmdArb = constantFrom(new GetStateCommand());
const hasPrevCmdArb = constantFrom(new HasPrevCommand());

const allCommands = [
  advanceNextCmdArb,
  advancePrevCmdArb,
  advanceFirstCmdArb,
  clearCmdArb,
  getStateCmdArb,
  hasPrevCmdArb,
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("model-based: pagination cursor stack", () => {
  test("random sequences of stack operations maintain consistency", async () => {
    await fcAssert(
      asyncProperty(commands(allCommands, { size: "+1" }), async (cmds) => {
        const cleanup = createIsolatedDbContext();
        try {
          const setup = () => ({
            model: createEmptyModel(),
            real: {} as RealDb,
          });
          await asyncModelRun(setup, cmds);
        } finally {
          cleanup();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS, verbose: false }
    );
  });

  test("composite key: different contexts are independent", () => {
    fcAssert(
      property(tuple(cursorArb, cursorArb), ([cursor1, cursor2]) => {
        const cleanup = createIsolatedDbContext();
        try {
          const ctx1 = "org:sentry";
          const ctx2 = "org:acme";

          // Advance in two different contexts
          advancePaginationState(CMD_KEY, ctx1, "next", cursor1);
          advancePaginationState(CMD_KEY, ctx2, "next", cursor2);

          const state1 = getPaginationState(CMD_KEY, ctx1);
          const state2 = getPaginationState(CMD_KEY, ctx2);

          expect(state1).toBeDefined();
          expect(state2).toBeDefined();
          expect(state1!.stack).toEqual(["", cursor1]);
          expect(state2!.stack).toEqual(["", cursor2]);

          // Clear one, the other remains
          clearPaginationState(CMD_KEY, ctx1);
          expect(getPaginationState(CMD_KEY, ctx1)).toBeUndefined();
          expect(getPaginationState(CMD_KEY, ctx2)).toBeDefined();
        } finally {
          cleanup();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("composite key: different command keys are independent", () => {
    fcAssert(
      property(tuple(cursorArb, cursorArb), ([cursor1, cursor2]) => {
        const cleanup = createIsolatedDbContext();
        try {
          const ctx = "org:sentry";
          const cmd1 = "project-list";
          const cmd2 = "issue-list";

          advancePaginationState(cmd1, ctx, "next", cursor1);
          advancePaginationState(cmd2, ctx, "next", cursor2);

          const state1 = getPaginationState(cmd1, ctx);
          const state2 = getPaginationState(cmd2, ctx);

          expect(state1!.stack).toEqual(["", cursor1]);
          expect(state2!.stack).toEqual(["", cursor2]);

          clearPaginationState(cmd1, ctx);
          expect(getPaginationState(cmd1, ctx)).toBeUndefined();
          expect(getPaginationState(cmd2, ctx)).toBeDefined();
        } finally {
          cleanup();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("forward then backward navigation preserves stack correctly", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Page 1 (initial)
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p2");
      let state = getPaginationState(CMD_KEY, CTX_KEY);
      expect(state).toEqual({ stack: ["", "cursor-p2"], index: 0 });
      expect(hasPreviousPage(CMD_KEY, CTX_KEY)).toBe(false);

      // Page 2 (advance next)
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p3");
      state = getPaginationState(CMD_KEY, CTX_KEY);
      expect(state).toEqual({
        stack: ["", "cursor-p2", "cursor-p3"],
        index: 1,
      });
      expect(hasPreviousPage(CMD_KEY, CTX_KEY)).toBe(true);

      // Page 3 (advance next)
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p4");
      state = getPaginationState(CMD_KEY, CTX_KEY);
      expect(state).toEqual({
        stack: ["", "cursor-p2", "cursor-p3", "cursor-p4"],
        index: 2,
      });

      // Go back to page 2
      advancePaginationState(CMD_KEY, CTX_KEY, "prev", "cursor-p3-refreshed");
      state = getPaginationState(CMD_KEY, CTX_KEY);
      expect(state!.index).toBe(1);
      expect(hasPreviousPage(CMD_KEY, CTX_KEY)).toBe(true);

      // Go back to page 1
      advancePaginationState(CMD_KEY, CTX_KEY, "prev", "cursor-p2-refreshed");
      state = getPaginationState(CMD_KEY, CTX_KEY);
      expect(state!.index).toBe(0);
      expect(hasPreviousPage(CMD_KEY, CTX_KEY)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("back-then-forward truncates stale entries", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Build up a 4-page stack
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "c2");
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "c3");
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "c4");
      // Now on page 3, stack: ["", "c2", "c3", "c4"]

      // Go back to page 2
      advancePaginationState(CMD_KEY, CTX_KEY, "prev", "c3-new");

      // Go forward from page 2 with a new cursor — should truncate c4
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "c4-new");
      const state = getPaginationState(CMD_KEY, CTX_KEY);
      expect(state!.index).toBe(2);
      // Old c4 should be gone, replaced by c4-new
      expect(state!.stack).toEqual(["", "c2", "c3-new", "c4-new"]);
    } finally {
      cleanup();
    }
  });

  test("resolveCursor: 'next' returns next stack entry", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Set up state with a next page available
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p2");
      // Now on page 0 with stack ["", "cursor-p2"]

      const resolved = resolveCursor("next", CMD_KEY, CTX_KEY);
      expect(resolved.cursor).toBe("cursor-p2");
      expect(resolved.direction).toBe("next");
    } finally {
      cleanup();
    }
  });

  test("resolveCursor: 'next' throws when no next page", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Set up state on last page (no next cursor)
      advancePaginationState(CMD_KEY, CTX_KEY, "next", undefined);

      expect(() => resolveCursor("next", CMD_KEY, CTX_KEY)).toThrow(
        /No next page/i
      );
    } finally {
      cleanup();
    }
  });

  test("resolveCursor: 'prev' returns previous stack entry", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Navigate to page 2
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p2");
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p3");
      // Now on page 1

      const resolved = resolveCursor("prev", CMD_KEY, CTX_KEY);
      // stack[0] is "" (first page) → cursor should be undefined
      expect(resolved.cursor).toBeUndefined();
      expect(resolved.direction).toBe("prev");
    } finally {
      cleanup();
    }
  });

  test("resolveCursor: 'prev' throws when on first page", () => {
    const cleanup = createIsolatedDbContext();
    try {
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p2");
      // On page 0

      expect(() => resolveCursor("prev", CMD_KEY, CTX_KEY)).toThrow(
        /first page/i
      );
    } finally {
      cleanup();
    }
  });

  test("resolveCursor: 'first' always returns undefined cursor", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Navigate forward a few pages
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p2");
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "cursor-p3");

      const resolved = resolveCursor("first", CMD_KEY, CTX_KEY);
      expect(resolved.cursor).toBeUndefined();
      expect(resolved.direction).toBe("first");
    } finally {
      cleanup();
    }
  });

  test("resolveCursor: undefined flag returns first page with 'first' direction", () => {
    const cleanup = createIsolatedDbContext();
    try {
      const resolved = resolveCursor(undefined, CMD_KEY, CTX_KEY);
      expect(resolved.cursor).toBeUndefined();
      expect(resolved.direction).toBe("first");
    } finally {
      cleanup();
    }
  });

  test("resolveCursor: raw cursor string is passed through", () => {
    const cleanup = createIsolatedDbContext();
    try {
      const resolved = resolveCursor("1735689600000:100:0", CMD_KEY, CTX_KEY);
      expect(resolved.cursor).toBe("1735689600000:100:0");
      expect(resolved.direction).toBe("next");
    } finally {
      cleanup();
    }
  });

  test("expired state returns undefined", () => {
    fcAssert(
      property(cursorArb, (cursor) => {
        const cleanup = createIsolatedDbContext();
        try {
          // Advance to create state, then manually expire it via direct DB write
          advancePaginationState(CMD_KEY, CTX_KEY, "next", cursor);

          // Verify state exists
          expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeDefined();

          // Expire it by writing directly to DB with past timestamp
          const db = getDatabase();
          db.query(
            "UPDATE pagination_cursors SET expires_at = ? WHERE command_key = ? AND context = ?"
          ).run(Date.now() - 1000, CMD_KEY, CTX_KEY);

          // Should return undefined
          expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeUndefined();

          // Row should be deleted after the expired read
          expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeUndefined();
        } finally {
          cleanup();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("get on empty table returns undefined", () => {
    const cleanup = createIsolatedDbContext();
    try {
      expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("clear on non-existent key is a no-op", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Should not throw
      clearPaginationState(CMD_KEY, CTX_KEY);
      expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("advance 'first' resets index to 0", () => {
    const cleanup = createIsolatedDbContext();
    try {
      // Navigate forward
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "c2");
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "c3");
      advancePaginationState(CMD_KEY, CTX_KEY, "next", "c4");
      expect(getPaginationState(CMD_KEY, CTX_KEY)!.index).toBe(2);

      // Jump to first
      advancePaginationState(CMD_KEY, CTX_KEY, "first", "c2-new");
      const state = getPaginationState(CMD_KEY, CTX_KEY);
      expect(state!.index).toBe(0);
      expect(state!.stack).toEqual(["", "c2-new"]);
      expect(hasPreviousPage(CMD_KEY, CTX_KEY)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
