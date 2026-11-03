/**
 * Ink select picker — the self-contained sidecar.
 *
 * Renders a filterable single-choice list for entity pickers (organization,
 * project, account). `text-import-plugin` bundles this file with its own
 * copies of ink and react into `ink-app.js`, which `ink-ui.ts` imports
 * lazily, so React never loads unless a picker is shown.
 */

import { Box, render as inkRender, Text } from "ink";
import { createElement, useCallback, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import {
  getInkFrameWidth,
  ShortcutFooter,
  useInkFrameSize,
} from "./ink-frame.js";
import {
  type ShortcutBinding,
  ShortcutHintProvider,
  useInkShortcuts,
} from "./ink-shortcuts.js";
import {
  filterSelectOptions,
  removeLastFilterCharacter,
  sanitizeSelectFilterInput,
} from "./select-filter.js";
import type { PromptDetail, SelectPrompt } from "./types.js";

// ──────────────────────────── Visual constants ────────────────────────

/** Sentry blurple — primary brand accent. */
const ACCENT = "#7553FF";
/** De-emphasized text that still clears dark terminal backgrounds. */
const MUTED = "#898294";
/** Lowest-contrast treatment for borders, counters, and supporting details. */
const MUTED_DIM = "#68616F";
const COLOR_SUCCESS = "#83da90";

const ICONS = {
  diamond: "\u25C6",
  diamondOpen: "\u25C7",
  separator: "\u250A",
  verticalLine: "\u2502",
  squareFilled: "\u25FC",
  squareOpen: "\u25FB",
  triangleRight: "\u25B6",
  triangleRightOutline: "\u25B7",
  triangleSmallRight: "\u25B8",
  bullet: "\u2022",
} as const;

// ─────────────────────────────── Prompts ──────────────────────────────

type PromptAlignment = "start" | "center";
type SelectPromptOptionData = SelectPrompt["options"][number];
type CenteredSelectLayout = {
  labelWidth: number;
  width: number;
};

function getCenteredSelectLayout(
  options: SelectPromptOptionData[],
): CenteredSelectLayout {
  const labelWidth = Math.max(
    0,
    ...options.map((option) => stringWidth(option.label)),
  );
  const hintWidth = Math.max(
    0,
    ...options.map((option) => stringWidth(option.hint ?? "")),
  );
  return {
    labelWidth,
    width: 2 + labelWidth + (hintWidth > 0 ? hintWidth + 1 : 0),
  };
}

/**
 * Rows unavailable to option lists: workflow chrome reserves the tab and
 * shortcut footers, multiselects add their local controls, and centered
 * prompts additionally reserve intro padding and the full banner.
 */
const WORKFLOW_PROMPT_RESERVED_ROWS = 10;
const WORKFLOW_MULTISELECT_RESERVED_ROWS = 12;
const CENTERED_SELECT_RESERVED_ROWS = 20;
const CENTERED_MULTISELECT_RESERVED_ROWS = 23;
const WORKFLOW_ACTIVITY_RESERVED_ROWS = 7;

/**
 * Returns the half-open option range that keeps the highlighted item visible.
 * The range never exceeds the requested viewport size or the option count.
 */
export function getOptionWindow(
  totalCount: number,
  highlighted: number,
  maxVisible: number,
): readonly [number, number] {
  const normalizedTotal = Math.max(0, Math.floor(totalCount));
  if (normalizedTotal === 0) {
    return [0, 0];
  }

  const viewportSize = Math.min(
    normalizedTotal,
    Math.max(1, Math.floor(maxVisible)),
  );
  const normalizedHighlight = Math.min(
    normalizedTotal - 1,
    Math.max(0, Math.floor(highlighted)),
  );
  const centeredStart = normalizedHighlight - Math.floor(viewportSize / 2);
  const start = Math.min(
    normalizedTotal - viewportSize,
    Math.max(0, centeredStart),
  );
  return [start, start + viewportSize];
}

function getPromptOptionCapacity({
  terminalRows,
  alignment,
  kind,
  occupiedRows,
  messageRows,
}: {
  terminalRows: number;
  alignment: PromptAlignment;
  kind: "select" | "multiselect";
  occupiedRows: number;
  messageRows: number;
}): number {
  let reservedRows =
    kind === "multiselect"
      ? WORKFLOW_MULTISELECT_RESERVED_ROWS
      : WORKFLOW_PROMPT_RESERVED_ROWS;
  if (alignment === "center") {
    reservedRows =
      kind === "multiselect"
        ? CENTERED_MULTISELECT_RESERVED_ROWS
        : CENTERED_SELECT_RESERVED_ROWS;
  }
  const extraMessageRows = Math.max(0, messageRows - 1);
  return terminalRows - reservedRows - occupiedRows - extraMessageRows;
}

function getPromptContentWidth(
  terminalColumns: number,
  alignment: PromptAlignment,
): number {
  const frameWidth = getInkFrameWidth(terminalColumns);
  if (alignment === "center") {
    return Math.min(frameWidth, 84);
  }
  return frameWidth >= 80 ? Math.floor((frameWidth - 1) * 0.6) : frameWidth;
}

function getPromptTextRows(text: string, availableWidth: number): number {
  return wrapAnsi(text, Math.max(1, availableWidth), {
    hard: true,
    trim: false,
    wordWrap: true,
  }).split("\n").length;
}

function getPromptDetailWidth(
  terminalColumns: number,
  alignment: PromptAlignment,
): number {
  const leadingWidth = alignment === "start" ? 3 : 0;
  return Math.max(
    1,
    getPromptContentWidth(terminalColumns, alignment) - leadingWidth,
  );
}

function getPromptDetailsRows(
  details: readonly PromptDetail[],
  availableWidth: number,
): number {
  return details.reduce(
    (rows, detail) => rows + getPromptTextRows(detail.text, availableWidth),
    0,
  );
}

function getStructuredSelectLayout({
  alignment,
  details,
  footer,
  occupiedRows,
  optionCount,
  promptTitle,
  terminalColumns,
  terminalRows,
}: {
  alignment: PromptAlignment;
  details: readonly PromptDetail[];
  footer?: PromptDetail;
  occupiedRows: number;
  optionCount: number;
  promptTitle: string;
  terminalColumns: number;
  terminalRows: number;
}): {
  compact: boolean;
  detailWidth: number;
  maxVisibleDetailRows: number;
  maxVisibleOptions: number;
} {
  const detailWidth = getPromptDetailWidth(terminalColumns, alignment);
  const titleRows = getPromptTextRows(promptTitle, detailWidth);
  const detailRows = getPromptDetailsRows(details, detailWidth);
  const footerRows = footer ? getPromptTextRows(footer.text, detailWidth) : 0;
  const optionRows = Math.max(1, optionCount);
  const minimumOptionRows =
    details.length > 0 && optionCount <= 2 ? optionRows : 1;
  const availableRows = Math.max(
    1,
    terminalRows - WORKFLOW_ACTIVITY_RESERVED_ROWS - occupiedRows,
  );
  const naturalSpacingRows = 2 + (footer ? 1 : 0);
  const naturalRows =
    titleRows + detailRows + footerRows + optionRows + naturalSpacingRows;

  if (naturalRows <= availableRows) {
    return {
      compact: false,
      detailWidth,
      maxVisibleDetailRows: detailRows + footerRows,
      maxVisibleOptions: optionRows,
    };
  }

  return {
    compact: true,
    detailWidth,
    maxVisibleDetailRows: Math.max(
      0,
      availableRows - titleRows - minimumOptionRows,
    ),
    maxVisibleOptions: minimumOptionRows,
  };
}

function getPromptMessageRows({
  message,
  terminalColumns,
  alignment,
  kind,
  totalCount,
}: {
  message: string;
  terminalColumns: number;
  alignment: PromptAlignment;
  kind: "select" | "multiselect";
  totalCount: number;
}): number {
  let availableWidth = getPromptContentWidth(terminalColumns, alignment);
  const countDigits = String(Math.max(1, totalCount)).length;

  if (kind === "select") {
    const positionWidth = stringWidth(
      `(${"9".repeat(countDigits)}/${"9".repeat(countDigits)})`,
    );
    availableWidth -= positionWidth + (alignment === "center" ? 1 : 3);
  } else if (alignment === "start") {
    const count = "9".repeat(countDigits);
    availableWidth -=
      stringWidth(`${count}/${count} selected • ${count}/${count}`) + 4;
  }

  return wrapAnsi(message, Math.max(1, availableWidth), {
    hard: true,
    trim: false,
    wordWrap: true,
  }).split("\n").length;
}

function PromptDetails({
  alignment,
  details,
}: {
  alignment: PromptAlignment;
  details: PromptDetail[];
}): React.ReactNode {
  const layoutProps =
    alignment === "center"
      ? ({ justifyContent: "center", width: "100%" } as const)
      : ({ paddingLeft: 3 } as const);
  return details.map((detail, index) => {
    const color = detail.tone === "success" ? COLOR_SUCCESS : MUTED;
    return (
      <Box key={`${index}:${detail.text}`} {...layoutProps}>
        <Text color={color}>{detail.text}</Text>
      </Box>
    );
  });
}

function normalizeDetailWindowStart(start: number, itemCount: number): number {
  return Math.min(Math.max(0, start), Math.max(0, itemCount - 1));
}

function getDetailWindowEnd(
  start: number,
  itemRows: readonly number[],
  rowBudget: number,
): number {
  let usedRows = 0;
  let end = normalizeDetailWindowStart(start, itemRows.length);
  while (end < itemRows.length) {
    const nextRows = itemRows[end] ?? 1;
    if (usedRows + nextRows > rowBudget) {
      break;
    }
    usedRows += nextRows;
    end += 1;
  }
  return end;
}

function getPreviousDetailWindowStart(
  start: number,
  itemRows: readonly number[],
  rowBudget: number,
): number {
  let previousStart = normalizeDetailWindowStart(start, itemRows.length);
  let usedRows = 0;
  while (previousStart > 0) {
    const nextRows = itemRows[previousStart - 1] ?? 1;
    if (usedRows + nextRows > rowBudget) {
      break;
    }
    usedRows += nextRows;
    previousStart -= 1;
  }
  return previousStart;
}

function getNextDetailWindowStart(
  start: number,
  itemRows: readonly number[],
  rowBudget: number,
): number {
  const currentStart = normalizeDetailWindowStart(start, itemRows.length);
  const windowEnd = getDetailWindowEnd(currentStart, itemRows, rowBudget);
  const nextStart = windowEnd === currentStart ? currentStart + 1 : windowEnd;
  return normalizeDetailWindowStart(nextStart, itemRows.length);
}

/**
 * Keeps the first detail pinned and pages the remaining details by their
 * wrapped row cost, reserving space for the footer and page indicator.
 */
function usePromptDetailWindow(
  promptDetails: PromptDetail[],
  maxVisibleRows: number,
  detailWidth: number,
  footer?: PromptDetail,
): {
  detailShortcut: ShortcutBinding | null;
  isWindowed: boolean;
  visibleDetails: PromptDetail[];
} {
  const detailLayout = useMemo(() => {
    const header = promptDetails[0];
    const items = header ? promptDetails.slice(1) : promptDetails;
    return {
      header,
      headerRows: header ? getPromptTextRows(header.text, detailWidth) : 0,
      itemRows: items.map((detail) =>
        getPromptTextRows(detail.text, detailWidth),
      ),
      items,
    };
  }, [detailWidth, promptDetails]);
  const footerRows = footer ? getPromptTextRows(footer.text, detailWidth) : 0;
  const allDetailRows =
    detailLayout.headerRows +
    detailLayout.itemRows.reduce((total, rows) => total + rows, 0) +
    footerRows;
  const isWindowed =
    allDetailRows > maxVisibleRows && detailLayout.items.length > 0;
  const indicatorRows = isWindowed
    ? getPromptTextRows(
        `${detailLayout.items.length}-${detailLayout.items.length}/${detailLayout.items.length} · pgup/pgdn`,
        detailWidth,
      )
    : 0;
  const itemRowBudget = Math.max(
    0,
    maxVisibleRows - detailLayout.headerRows - footerRows - indicatorRows,
  );
  const [windowStart, setWindowStart] = useState(0);
  const normalizedStart = normalizeDetailWindowStart(
    windowStart,
    detailLayout.items.length,
  );
  const windowEnd = getDetailWindowEnd(
    normalizedStart,
    detailLayout.itemRows,
    itemRowBudget,
  );
  const visibleDetails = isWindowed
    ? [
        ...(detailLayout.header === undefined ? [] : [detailLayout.header]),
        ...detailLayout.items.slice(normalizedStart, windowEnd),
        {
          text: `${normalizedStart + 1}-${windowEnd}/${detailLayout.items.length} · pgup/pgdn`,
        },
      ]
    : promptDetails;
  const detailShortcut = useMemo<ShortcutBinding | null>(() => {
    if (!isWindowed) {
      return null;
    }
    return {
      key: "pgup/pgdn",
      action: "review features",
      priority: 41,
      showInFooter: false,
      match: (_input, key) => key.pageUp || key.pageDown,
      run: (_input, key) => {
        const moveWindow = key.pageUp
          ? getPreviousDetailWindowStart
          : getNextDetailWindowStart;
        setWindowStart((start) =>
          moveWindow(start, detailLayout.itemRows, itemRowBudget),
        );
      },
    };
  }, [detailLayout, isWindowed, itemRowBudget]);

  return { detailShortcut, isWindowed, visibleDetails };
}

function PromptFooter({
  alignment,
  compact,
  detail,
}: {
  alignment: PromptAlignment;
  compact: boolean;
  detail?: PromptDetail;
}): React.ReactNode {
  if (!detail) {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1}>
      <PromptDetails alignment={alignment} details={[detail]} />
    </Box>
  );
}

function SelectPromptHeader({
  alignment,
  compact,
  detailsAreWindowed,
  footer,
  isOptionWindowed,
  highlighted,
  minTitleRows,
  promptTitle,
  totalCount,
  visiblePromptDetails,
}: {
  alignment: PromptAlignment;
  compact: boolean;
  detailsAreWindowed: boolean;
  footer?: PromptDetail;
  isOptionWindowed: boolean;
  highlighted: number;
  minTitleRows?: number;
  promptTitle: string;
  totalCount: number;
  visiblePromptDetails: PromptDetail[];
}): React.ReactNode {
  const position = isOptionWindowed ? (
    <Text color={MUTED_DIM}>
      ({highlighted + 1}/{totalCount})
    </Text>
  ) : null;
  const detailRows = (
    <>
      <PromptDetails alignment={alignment} details={visiblePromptDetails} />
      <PromptFooter
        alignment={alignment}
        compact={compact || detailsAreWindowed}
        detail={footer}
      />
    </>
  );

  if (alignment === "center") {
    return (
      <Box flexDirection="column" marginBottom={compact ? 0 : 1} width="100%">
        <Box
          gap={1}
          justifyContent="center"
          minHeight={minTitleRows}
          width="100%"
        >
          <Text bold>{promptTitle}</Text>
          {position}
        </Box>
        {detailRows}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
      <Box minHeight={minTitleRows}>
        <Box flexShrink={0} width={3}>
          <Text bold color={ACCENT}>
            {ICONS.diamondOpen}
          </Text>
        </Box>
        <Text bold>{promptTitle}</Text>
        {position}
      </Box>
      {detailRows}
    </Box>
  );
}

function SelectPromptArea({
  alignment,
  occupiedRows,
  prompt,
}: {
  alignment: PromptAlignment;
  occupiedRows: number;
  prompt: SelectPrompt;
}): React.ReactNode {
  const { columns, rows } = useInkFrameSize();
  const reservedRows = occupiedRows + (prompt.filterable ? 1 : 0);
  const hasStructuredCopy =
    (prompt.details?.length ?? 0) > 0 || prompt.footer !== undefined;
  if (alignment === "start" && hasStructuredCopy) {
    const layout = getStructuredSelectLayout({
      alignment,
      details: prompt.details ?? [],
      footer: prompt.footer,
      occupiedRows: reservedRows,
      optionCount: prompt.options.length,
      promptTitle: prompt.message,
      terminalColumns: columns,
      terminalRows: rows,
    });
    return (
      <SelectPrompt
        alignment={alignment}
        compact={layout.compact}
        detailWidth={layout.detailWidth}
        maxVisibleDetailRows={layout.maxVisibleDetailRows}
        maxVisibleOptions={layout.maxVisibleOptions}
        prompt={prompt}
      />
    );
  }

  const promptMessage = [
    prompt.message,
    ...(prompt.details ?? []).map((detail) => detail.text),
    ...(prompt.footer ? ["", prompt.footer.text] : []),
  ].join("\n");
  const messageRows = getPromptMessageRows({
    message: promptMessage,
    terminalColumns: columns,
    alignment,
    kind: prompt.kind,
    totalCount: prompt.options.length,
  });
  const optionCapacity = getPromptOptionCapacity({
    terminalRows: rows,
    alignment,
    kind: prompt.kind,
    occupiedRows: reservedRows,
    messageRows,
  });
  const optionLimit = Math.max(1, optionCapacity);
  const minimumVisibleOptions =
    (prompt.details?.length ?? 0) > 0 && prompt.options.length <= 2
      ? prompt.options.length
      : 1;
  const maxVisibleDetailRows = Math.max(
    0,
    messageRows - 1 - Math.max(0, minimumVisibleOptions - optionCapacity),
  );
  return (
    <SelectPrompt
      alignment={alignment}
      compact={optionLimit < minimumVisibleOptions}
      detailWidth={getPromptDetailWidth(columns, alignment)}
      maxVisibleDetailRows={maxVisibleDetailRows}
      maxVisibleOptions={Math.max(minimumVisibleOptions, optionLimit)}
      prompt={prompt}
    />
  );
}

function SelectPrompt({
  alignment,
  compact,
  detailWidth,
  maxVisibleDetailRows,
  maxVisibleOptions,
  prompt,
}: {
  alignment: PromptAlignment;
  compact: boolean;
  detailWidth: number;
  maxVisibleDetailRows: number;
  maxVisibleOptions: number;
  prompt: SelectPrompt;
}): React.ReactNode {
  const isCentered = alignment === "center";
  const promptWidth = isCentered ? "100%" : undefined;
  const promptTitle = prompt.message;
  const promptDetails = prompt.details ?? [];
  const {
    detailShortcut,
    isWindowed: detailsAreWindowed,
    visibleDetails: visiblePromptDetails,
  } = usePromptDetailWindow(
    promptDetails,
    maxVisibleDetailRows,
    detailWidth,
    prompt.footer,
  );
  const { columns } = useInkFrameSize();
  const centeredLayout = isCentered
    ? getCenteredSelectLayout(prompt.options)
    : null;
  const centeredOptionsWidth = centeredLayout
    ? Math.min(centeredLayout.width, getPromptContentWidth(columns, alignment))
    : undefined;
  const initialHighlighted = Math.min(
    Math.max(prompt.initialIndex, 0),
    Math.max(0, prompt.options.length - 1),
  );
  const [selection, setSelection] = useState({
    prompt,
    query: "",
    highlighted: initialHighlighted,
  });
  const selectionRef = useRef(selection);
  // Ink can deliver paste and Enter before React commits the next render.
  const updateSelection = useCallback(
    (update: (state: typeof selection) => typeof selection) => {
      const next = update(selectionRef.current);
      selectionRef.current = next;
      setSelection(next);
    },
    [],
  );
  // Successive wizard prompts can replace each other without unmounting.
  if (selection.prompt !== prompt) {
    const next = { prompt, query: "", highlighted: initialHighlighted };
    selectionRef.current = next;
    setSelection(next);
  }
  const { query, highlighted } = selection;
  const filteredOptions = filterSelectOptions(prompt.options, query);
  const totalCount = filteredOptions.length;
  const [windowStart, windowEnd] = getOptionWindow(
    totalCount,
    highlighted,
    maxVisibleOptions,
  );
  const visibleOptions = filteredOptions.slice(windowStart, windowEnd);
  const isWindowed = visibleOptions.length < totalCount;
  // Keep the title's height when filtering removes its window position counter.
  const minTitleRows =
    prompt.filterable && prompt.options.length > maxVisibleOptions
      ? getPromptMessageRows({
          message: promptTitle,
          terminalColumns: columns,
          alignment,
          kind: "select",
          totalCount: prompt.options.length,
        })
      : undefined;

  const shortcuts = useMemo<ShortcutBinding[]>(
    () => [
      {
        key: "\u2191\u2193",
        action: "navigate",
        priority: 40,
        match: (_input, key) => key.upArrow || key.downArrow,
        run: (_input, key) => {
          updateSelection((state) => {
            const count = filterSelectOptions(
              prompt.options,
              state.query,
            ).length;
            if (count === 0) {
              return state;
            }
            return {
              ...state,
              highlighted:
                (state.highlighted + (key.upArrow ? count - 1 : 1)) % count,
            };
          });
        },
      },
      ...(detailShortcut ? [detailShortcut] : []),
      {
        key: "enter",
        action: "confirm",
        priority: 42,
        match: (_input, key) => key.return,
        run: () => {
          const state = selectionRef.current;
          const current = filterSelectOptions(prompt.options, state.query)[
            state.highlighted
          ];
          if (current) {
            prompt.resolve(current.value);
          }
        },
      },
      {
        key: "esc",
        action: query ? "clear filter" : "cancel",
        priority: 43,
        match: (input, key) => key.escape || (key.ctrl && input === "c"),
        run: (input, key) => {
          if (key.ctrl && input === "c") {
            prompt.resolve(null);
          } else if (selectionRef.current.query) {
            updateSelection((state) => ({
              ...state,
              query: "",
              highlighted: 0,
            }));
          } else {
            prompt.resolve(null);
          }
        },
      },
      ...(prompt.filterable
        ? ([
            {
              key: "backspace",
              action: "delete",
              showInFooter: false,
              match: (_input, key) => key.backspace || key.delete,
              run: () => {
                updateSelection((state) => {
                  if (!state.query) {
                    return state;
                  }
                  return {
                    ...state,
                    query: removeLastFilterCharacter(state.query),
                    highlighted: 0,
                  };
                });
              },
            },
            {
              key: "type",
              action: "filter",
              showInFooter: false,
              match: (input, key) =>
                !(key.ctrl || key.meta || key.tab) &&
                sanitizeSelectFilterInput(input).length > 0,
              run: (input) => {
                const text = sanitizeSelectFilterInput(input);
                updateSelection((state) => ({
                  ...state,
                  query: state.query + text,
                  highlighted: 0,
                }));
              },
            },
          ] satisfies ShortcutBinding[])
        : []),
    ],
    [detailShortcut, prompt, query, updateSelection],
  );
  useInkShortcuts("select-prompt", shortcuts);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginTop={compact ? 0 : 1}
      width={promptWidth}
    >
      <SelectPromptHeader
        alignment={alignment}
        compact={compact}
        detailsAreWindowed={detailsAreWindowed}
        footer={prompt.footer}
        highlighted={highlighted}
        isOptionWindowed={isWindowed}
        minTitleRows={minTitleRows}
        promptTitle={promptTitle}
        totalCount={totalCount}
        visiblePromptDetails={visiblePromptDetails}
      />
      <Box
        justifyContent={isCentered ? "center" : "flex-start"}
        minHeight={Math.min(prompt.options.length, maxVisibleOptions)}
        width={promptWidth}
      >
        {totalCount === 0 ? (
          <Text color={MUTED} wrap="truncate">
            No matches
          </Text>
        ) : (
          <Box flexDirection="column" width={centeredOptionsWidth}>
            {visibleOptions.map((option, visibleIndex) => {
              const idx = windowStart + visibleIndex;
              const isCursor = idx === highlighted;
              return (
                <SelectPromptOptionRow
                  centered={isCentered}
                  centeredLabelWidth={centeredLayout?.labelWidth}
                  isCursor={isCursor}
                  key={option.value}
                  option={option}
                  query={query}
                />
              );
            })}
          </Box>
        )}
      </Box>
      {prompt.filterable ? (
        <SelectFilterStatus
          centered={isCentered}
          matches={totalCount}
          query={query}
          total={prompt.options.length}
        />
      ) : null}
    </Box>
  );
}

function SelectFilterStatus({
  centered,
  matches,
  query,
  total,
}: {
  centered: boolean;
  matches: number;
  query: string;
  total: number;
}): React.ReactNode {
  const color = query ? ACCENT : MUTED;
  return (
    <Box
      gap={1}
      height={1}
      justifyContent={centered ? "center" : "flex-start"}
      overflow="hidden"
      paddingLeft={centered ? 0 : 3}
      width="100%"
    >
      <Box flexShrink={1}>
        <Text color={color} wrap="truncate">
          {query ? `/${query}` : "type to filter"}
        </Text>
      </Box>
      {query ? (
        <Box flexShrink={0}>
          <Text color={MUTED}>{`${matches} of ${total}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SelectOptionText({
  text,
  query,
}: {
  text: string;
  query: string;
}): React.ReactNode {
  const start = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (start === -1) {
    return text;
  }
  return (
    <>
      {text.slice(0, start)}
      <Text color={ACCENT}>{text.slice(start, start + query.length)}</Text>
      {text.slice(start + query.length)}
    </>
  );
}

function SelectPromptOptionRow({
  centered,
  centeredLabelWidth,
  isCursor,
  option,
  query,
}: {
  centered: boolean;
  centeredLabelWidth?: number;
  isCursor: boolean;
  option: SelectPromptOptionData;
  query: string;
}): React.ReactNode {
  if (centered) {
    return (
      <Box flexDirection="row" height={1} overflow="hidden" width="100%">
        <Box flexShrink={0} width={2}>
          <Text color={ACCENT}>{isCursor ? ICONS.triangleRight : " "}</Text>
        </Box>
        <Box flexShrink={0} width={centeredLabelWidth}>
          <Text bold={isCursor}>
            <SelectOptionText query={query} text={option.label} />
          </Text>
        </Box>
        {option.hint !== undefined && option.hint !== "" ? (
          <Text color={MUTED}>
            {" "}
            <SelectOptionText query={query} text={option.hint} />
          </Text>
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      <Box flexShrink={0} width={3}>
        <Text color={ACCENT}>{isCursor ? ICONS.triangleRight : " "}</Text>
      </Box>
      {/* Keep the label when a long hint fills the row; the hint is clipped. */}
      <Box flexShrink={0}>
        <Text bold={isCursor}>
          <SelectOptionText query={query} text={option.label} />
        </Text>
      </Box>
      {option.hint !== undefined && option.hint !== "" ? (
        <Text color={MUTED}>
          {" "}
          <SelectOptionText query={query} text={option.hint} />
        </Text>
      ) : null}
    </Box>
  );
}

/** Compact entity picker (organization, project, account). */
export function SelectPicker({
  prompt,
}: {
  prompt: SelectPrompt;
}): React.ReactNode {
  return (
    <ShortcutHintProvider>
      <Box flexDirection="column">
        <SelectPromptArea alignment="start" occupiedRows={0} prompt={prompt} />
        <ShortcutFooter color={MUTED_DIM} />
      </Box>
    </ShortcutHintProvider>
  );
}

/** Ink render options the picker accepts. */
type MountOptions = {
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  stdin?: import("node:tty").ReadStream;
};

/** The parts of the Ink instance the loader in `ink-ui.ts` uses. */
type MountedPicker = {
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  clear: () => void;
};

/**
 * Mount the picker with the sidecar's own Ink and React instances.
 *
 * This must live inside the sidecar so the picker's hooks and `ink.render()`
 * share one copy of React; a second copy in the main bundle causes "Invalid
 * hook call" errors.
 */
export function mountSelectPrompt(
  prompt: SelectPrompt,
  options: MountOptions,
): MountedPicker {
  return inkRender(createElement(SelectPicker, { prompt }), options);
}
