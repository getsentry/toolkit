/**
 * InkUI React App — Full-Screen Wizard
 *
 * Renders the wizard in alternate-screen mode using Ink. The layout
 * fills the terminal:
 *
 *   ┌─ ◆ Sentry Init Wizard ──────────────────── sentry.io ─┐
 *   │                                                         │
 *   │  ╔═══╗                    │  ╭ Tasks ────── 2/8 ──────╮ │
 *   │  ║ S ║  Sentry banner     │  │ ◼ Analyze project      │ │
 *   │  ╚═══╝                    │  │ ▶ Apply changes         │ │
 *   │  ● log line               │  ╰────────────────────────╯ │
 *   │  ▲ log line               │                             │
 *   │                           │  ╭ Did you know? ─────────╮ │
 *   │  ◐ spinner...             │  │ Errors → context → fix │ │
 *   │  [PromptArea]             │  │ <tip>                  │ │
 *   │                           │  ╰────────────────────────╯ │
 *   │  ● Status   Files                                       │
 *   │  ←→ switch tab                                          │
 *   │  Sentry                         $ sentry cli feedback... │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Tab 1 (Status): Banner + logs + spinner + prompts + summary
 * Tab 2 (Files): Scrollable file read tree
 */

import { Box, render as inkRender, Text } from "ink";
import Spinner from "ink-spinner";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import {
  type BannerLine,
  bannerLinesForWidth,
  bannerLinesWidth,
} from "../../banner.js";
import {
  buildFileTree,
  buildReadTree,
  type FileTreeRow,
  flattenTree,
} from "./file-tree.js";
import {
  type FrameTab,
  getInkFrameMargin,
  getInkFrameWidth,
  InitRenderBoundary,
  ShortcutFooter,
  TabFooter,
  useInkFrameSize,
} from "./ink-frame.js";
import {
  type ShortcutBinding,
  ShortcutHintProvider,
  useInkShortcuts,
} from "./ink-shortcuts.js";
import { BLOCK_LINE_COUNT, LEARN_SEQUENCE } from "./learn-content.js";
import { SENTRY_TIPS, type SentryTip } from "./sentry-tips.js";
import type {
  CompletionActions,
  PromptDetail,
  WizardCompletion,
  WizardSummary,
} from "./types.js";
import type {
  ActivePrompt,
  FileReadEntry,
  LearnState,
  LogEntry,
  LogSeverity,
  SpinnerState,
  StepEntry,
  WizardStore,
} from "./wizard-store.js";

// ──────────────────────────── Visual constants ────────────────────────

/** Sentry blurple — primary brand accent. */
const ACCENT = "#7553FF";
/** De-emphasized text that still clears dark terminal backgrounds. */
const MUTED = "#898294";
/** Lowest-contrast treatment for borders, counters, and supporting details. */
const MUTED_DIM = "#68616F";
/** Sentry purple — spinners, in-progress states. */
const PRIMARY = "#8B6AC8";

const COLOR_INFO = "#9C84D4";
const COLOR_WARN = "#FDB81B";
const COLOR_ERROR = "#fe4144";
const COLOR_SUCCESS = "#83da90";
const ACTIVE_TASK_PULSE_INTERVAL_MS = 600;

const ICON_BY_SEVERITY: Record<LogSeverity, { glyph: string; color?: string }> =
  {
    info: { glyph: "●", color: COLOR_INFO },
    warn: { glyph: "▲", color: COLOR_WARN },
    error: { glyph: "✖", color: COLOR_ERROR },
    success: { glyph: "✔", color: COLOR_SUCCESS },
    message: { glyph: " " },
  };

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

const DEFAULT_WELCOME_OPTIONS = {
  title: "Sentry Init",
  body: [
    "We'll use AI to inspect this project and configure Sentry.",
    "You'll choose the setup before local files change.",
  ],
  punchline: "Continue to let Sentry use AI for setup.",
};
const FEEDBACK_BANNER_TEXT = '$ sentry cli feedback "what worked or broke"';
const FEEDBACK_BANNER_FG = "#FFFFFF";

function getIntroTopPadding(rows: number): number {
  return Math.min(6, Math.max(1, Math.floor(rows * 0.18)));
}

function truncateForBanner(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatBannerBrand(cliVersion: string | null): string {
  return cliVersion ? `Sentry v${cliVersion}` : "Sentry";
}

/** @internal Exported for testing. */
export function formatFeedbackBanner(
  width: number,
  cliVersion: string | null
): string {
  const brand = formatBannerBrand(cliVersion);
  const left = ` ${brand}`;
  if (width <= left.length) {
    return left.slice(0, Math.max(0, width));
  }

  const rightPadding = 1;
  const maxRight = Math.max(0, width - left.length - rightPadding - 1);
  const clippedRight = truncateForBanner(FEEDBACK_BANNER_TEXT, maxRight);
  if (clippedRight.length === 0) {
    return left.padEnd(width, " ");
  }

  const spacerWidth = Math.max(
    1,
    width - left.length - clippedRight.length - rightPadding
  );
  return `${left}${" ".repeat(spacerWidth)}${clippedRight}${" ".repeat(rightPadding)}`;
}

// ────────────────────────────── App entry ─────────────────────────────

export type AppProps = {
  store: WizardStore;
};

export function App({ store }: AppProps): React.ReactNode {
  return (
    <ShortcutHintProvider>
      <AppBody store={store} />
    </ShortcutHintProvider>
  );
}

function AppBody({ store }: AppProps): React.ReactNode {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  const { columns, rows } = useInkFrameSize();
  const [activeTab, setActiveTab] = useState(0);

  const width = getInkFrameWidth(columns);
  const contentHeight = Math.max(5, rows - 4);
  const isWide = width >= 80;

  const tabs = useMemo<FrameTab[]>(
    () => [
      { id: "status", label: "Status" },
      { id: "files", label: "Files" },
    ],
    []
  );

  const appShortcuts = useMemo<ShortcutBinding[]>(() => {
    const bindings: ShortcutBinding[] = [
      {
        key: "ctrl+c",
        action: "cancel",
        priority: 0,
        showInFooter: false,
        match: (input, key) => key.ctrl && input === "c",
        run: () => snapshot.requestCancel?.(),
      },
      {
        key: "\u2190\u2192",
        action: "switch tab",
        priority: 10,
        match: (_input, key) => key.leftArrow || key.rightArrow,
        run: (_input, key) => {
          if (key.leftArrow) {
            setActiveTab((prev) => Math.max(0, prev - 1));
          }
          if (key.rightArrow) {
            setActiveTab((prev) => Math.min(tabs.length - 1, prev + 1));
          }
        },
      },
    ];
    return bindings;
  }, [snapshot.requestCancel, tabs.length]);
  useInkShortcuts("init-app", appShortcuts, {
    isActive:
      snapshot.layout === "workflow" &&
      snapshot.prompt === null &&
      snapshot.outroState === null,
  });

  if (snapshot.outroState?.kind === "success") {
    return (
      <InitRenderBoundary errorColor={COLOR_ERROR}>
        <CompletionScreen
          actions={snapshot.outroState.actions}
          cliVersion={snapshot.cliVersion}
          columns={columns}
          completion={snapshot.summary?.completion ?? null}
          onDismiss={snapshot.outroState.dismiss}
          postExitActions={snapshot.postExitActions}
          rows={rows}
          store={store}
          width={width}
        />
      </InitRenderBoundary>
    );
  }

  if (snapshot.layout === "intro" || snapshot.prompt?.kind === "welcome") {
    const inner = (
      <Box
        flexDirection="column"
        height={rows}
        marginLeft={getInkFrameMargin(columns, width)}
        width={width}
      >
        <Box
          alignItems="center"
          flexDirection="column"
          flexGrow={1}
          paddingTop={getIntroTopPadding(rows)}
        >
          <IntroScreen
            bannerRows={snapshot.bannerRows}
            logs={snapshot.logs}
            prompt={snapshot.prompt}
            spinner={snapshot.spinner}
            width={width}
          />
        </Box>
        <FeedbackBanner cliVersion={snapshot.cliVersion} width={width} />
      </Box>
    );
    return (
      <InitRenderBoundary errorColor={COLOR_ERROR}>{inner}</InitRenderBoundary>
    );
  }

  const inner = (
    <Box
      flexDirection="column"
      height={rows}
      marginLeft={getInkFrameMargin(columns, width)}
      width={width}
    >
      <Box flexDirection="column" flexGrow={1} paddingTop={1}>
        <Box flexDirection="column" height={contentHeight}>
          <Box
            flexDirection="row"
            flexGrow={1}
            flexShrink={1}
            gap={isWide ? 1 : 0}
            overflow="hidden"
          >
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {activeTab === 0 ? (
                <ActivityPane
                  logs={snapshot.logs}
                  prompt={snapshot.prompt}
                  spinner={snapshot.spinner}
                  summary={snapshot.summary}
                  terminalRows={rows}
                />
              ) : (
                <FilesScreen
                  filesRead={snapshot.filesRead}
                  hasActivePrompt={snapshot.prompt !== null}
                  terminalRows={rows}
                />
              )}
            </Box>
            {isWide ? (
              <Sidebar
                learnState={snapshot.learnState}
                steps={snapshot.steps}
                terminalRows={rows}
                tipIndex={snapshot.tipIndex}
              />
            ) : null}
          </Box>

          {snapshot.overlay ? (
            <OverlayPanel overlay={snapshot.overlay} />
          ) : null}

          <TabFooter
            activeColor={ACCENT}
            activeGlyph={ICONS.bullet}
            activeTab={activeTab}
            inactiveColor={MUTED_DIM}
            tabs={tabs}
          />
          <ShortcutFooter color={MUTED_DIM} />
          <FeedbackBanner cliVersion={snapshot.cliVersion} width={width} />
        </Box>
      </Box>
    </Box>
  );

  return (
    <InitRenderBoundary errorColor={COLOR_ERROR}>{inner}</InitRenderBoundary>
  );
}

// ────────────────────────────── Sidebar ───────────────────────────────

function Sidebar({
  learnState,
  steps,
  terminalRows,
  tipIndex,
}: {
  learnState: LearnState;
  steps: StepEntry[];
  terminalRows: number;
  tipIndex: number;
}): React.ReactNode {
  const showTips = terminalRows >= 24;
  return (
    <Box flexDirection="column" overflow="hidden" width="40%">
      <ProgressPanel steps={steps} />
      {showTips ? (
        <>
          <Box height={1} />
          {learnState.complete ? (
            <TipPanel tipIndex={tipIndex} />
          ) : (
            <LearnPanel learnState={learnState} />
          )}
        </>
      ) : null}
    </Box>
  );
}

// ─────────────────────────── Activity Pane ────────────────────────────

function ActivityPane({
  logs,
  spinner,
  prompt,
  summary,
  terminalRows,
}: {
  logs: LogEntry[];
  spinner: SpinnerState;
  prompt: ActivePrompt | null;
  summary: WizardSummary | null;
  terminalRows: number;
}): React.ReactNode {
  const promptLogs = logs.filter(
    (log) => log.severity === "warn" || log.severity === "error"
  );
  // The shortest supported frame can keep one actionable log above a prompt;
  // roomier terminals retain the complete warning/error history.
  let visibleLogs = logs;
  if (prompt) {
    visibleLogs = terminalRows <= 16 ? promptLogs.slice(-1) : promptLogs;
  }
  const hasContent =
    visibleLogs.length > 0 ||
    spinner.active ||
    prompt !== null ||
    summary !== null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {hasContent ? null : (
        <Box flexDirection="column" paddingTop={1}>
          <Box gap={1}>
            <Text color={PRIMARY}>
              <Spinner type="dots" />
            </Text>
            <Text dimColor>Initializing wizard...</Text>
          </Box>
        </Box>
      )}
      {visibleLogs.length > 0 ? (
        <Box flexDirection="column" flexShrink={1} overflow="hidden">
          {visibleLogs.map((log) => (
            <LogLine entry={log} key={log.id} />
          ))}
        </Box>
      ) : null}
      {spinner.active ? <SpinnerRow state={spinner} /> : null}
      {summary ? <SummaryPanel summary={summary} /> : null}
      {prompt ? (
        <PromptArea
          occupiedRows={visibleLogs.length + (spinner.active ? 2 : 0)}
          prompt={prompt}
        />
      ) : null}
    </Box>
  );
}

// ─────────────────────────── Files Screen ─────────────────────────────

function FilesScreen({
  filesRead,
  hasActivePrompt,
  terminalRows,
}: {
  filesRead: FileReadEntry[];
  hasActivePrompt: boolean;
  terminalRows: number;
}): React.ReactNode {
  if (filesRead.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingTop={1} paddingX={1}>
        <Text dimColor>No files read yet...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <FilesPanel
        filesRead={filesRead}
        hasActivePrompt={hasActivePrompt}
        maxRows={Math.max(4, terminalRows - 10)}
      />
    </Box>
  );
}

// ──────────────────────────── Outro Screen ────────────────────────────

// ──────────────────────────── Overlay ─────────────────────────────────

function OverlayPanel({
  overlay,
}: {
  overlay: NonNullable<import("./wizard-store.js").Overlay>;
}): React.ReactNode {
  return (
    <Box
      borderColor={COLOR_WARN}
      borderStyle="round"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Box gap={1}>
        <Text color={COLOR_WARN}>▲</Text>
        <Text bold>{overlay.message}</Text>
      </Box>
      {overlay.retryCount > 0 ? (
        <Box paddingLeft={3}>
          <Text dimColor>Retry {overlay.retryCount}...</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ──────────────────────────── Components ──────────────────────────────

type ChoiceRow<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

function useChoiceNavigation<T extends string>({
  choices,
  onChoose,
  onCancel,
  scope,
}: {
  choices: ChoiceRow<T>[];
  onChoose: (value: T) => void;
  onCancel: () => void;
  scope: string;
}): number {
  const [highlighted, setHighlighted] = useState(0);
  const totalCount = choices.length;

  const shortcuts = useMemo<ShortcutBinding[]>(
    () => [
      {
        key: "\u2191\u2193",
        action: "navigate",
        priority: 40,
        match: (_input, key) => key.upArrow || key.downArrow,
        run: (_input, key) => {
          if (key.upArrow) {
            setHighlighted((idx) => (idx === 0 ? totalCount - 1 : idx - 1));
            return;
          }
          setHighlighted((idx) => (idx + 1) % totalCount);
        },
      },
      {
        key: "enter",
        action: "select",
        priority: 41,
        match: (_input, key) => key.return,
        run: () => {
          const current = choices[highlighted];
          if (current) {
            onChoose(current.value);
          }
        },
      },
      {
        key: "esc",
        action: "cancel",
        priority: 42,
        match: (input, key) => key.escape || (key.ctrl && input === "c"),
        run: onCancel,
      },
    ],
    [choices, highlighted, onCancel, onChoose, totalCount]
  );
  useInkShortcuts(scope, shortcuts);

  return highlighted;
}

function ActionList<T extends string>({
  centered = false,
  choices,
  highlighted,
}: {
  centered?: boolean;
  choices: ChoiceRow<T>[];
  highlighted: number;
}): React.ReactNode {
  const listWidth = centered ? "100%" : undefined;
  return (
    <Box flexDirection="column" width={listWidth}>
      {choices.map((choice, index) => {
        const isCursor = index === highlighted;
        if (centered) {
          return (
            <Box
              flexDirection="row"
              justifyContent="center"
              key={choice.value}
              width="100%"
            >
              <Text color={ACCENT}>
                {isCursor ? `${ICONS.triangleRight} ` : "  "}
              </Text>
              <Text bold={isCursor}>{choice.label}</Text>
              {choice.hint ? <Text color={MUTED}> {choice.hint}</Text> : null}
            </Box>
          );
        }
        return (
          <Box flexDirection="row" key={choice.value}>
            <Box flexShrink={0} width={4}>
              <Text color={ACCENT}>{isCursor ? ICONS.triangleRight : " "}</Text>
            </Box>
            <Text bold={isCursor}>{choice.label}</Text>
            {choice.hint ? <Text color={MUTED}> {choice.hint}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

function FeedbackBanner({
  cliVersion,
  width,
}: {
  cliVersion: string | null;
  width: number;
}): React.ReactNode {
  return (
    <Box flexShrink={0} height={1}>
      <Text backgroundColor={ACCENT} color={FEEDBACK_BANNER_FG}>
        {formatFeedbackBanner(width, cliVersion)}
      </Text>
    </Box>
  );
}

// ────────────────────────── Completion Screen ─────────────────────────

type CompletionActionId = "issues" | "agent" | "finish";

/** Build the "What's next?" menu from the completion data + current state.
 * Pick one, run it, and come back — the plugin item shows its queued state so
 * doing several reads clearly. */
function buildCompletionMenu({
  agentCommand,
  agentQueued,
  completion,
  primaryUrl,
}: {
  agentCommand: string | undefined;
  agentQueued: boolean;
  completion: WizardCompletion | null;
  primaryUrl: string | undefined;
}): ChoiceRow<CompletionActionId>[] {
  const list: ChoiceRow<CompletionActionId>[] = [];
  if (primaryUrl) {
    list.push(
      completion?.verification.eventUrl
        ? {
            value: "issues",
            label: "View my first event",
            hint: "opens the exact event",
          }
        : {
            value: "issues",
            label: "Open my Issues feed",
            hint: "see your first error",
          }
    );
  }
  if (agentCommand) {
    list.push({
      value: "agent",
      label: agentQueued
        ? "Agent plugin — queued ✓"
        : "Install the Sentry agent plugin",
      hint: agentQueued ? "runs when you finish" : agentCommand,
    });
  }
  list.push({ value: "finish", label: "Finish" });
  return list;
}

/**
 * The interactive exit screen. Speaks the same visual language as the rest of
 * init — no boxed hero, glyph-aligned rows, and the prompt option idiom — with
 * a clear hierarchy:
 *   - what happened (Sentry installed, what was enabled), unnumbered context,
 *   1. see your first error — the focal step,
 *   2. next steps (MCP, agent plugin) as a driveable menu.
 */
function CompletionScreen({
  actions,
  cliVersion,
  columns,
  completion,
  onDismiss,
  postExitActions,
  rows,
  store,
  width,
}: {
  actions: CompletionActions;
  cliVersion: string | null;
  columns: number;
  completion: WizardCompletion | null;
  onDismiss: () => void;
  postExitActions: string[];
  rows: number;
  store: WizardStore;
  width: number;
}): React.ReactNode {
  const [note, setNote] = useState("");

  const verified = completion?.verification.received ?? false;
  const primaryUrl = completion?.verification.eventUrl ?? completion?.issuesUrl;
  const agentCommand = completion?.agentInstallCommand;
  const agentQueued = agentCommand
    ? postExitActions.includes(agentCommand)
    : false;

  const menuChoices = useMemo(
    () =>
      buildCompletionMenu({
        agentCommand,
        agentQueued,
        completion,
        primaryUrl,
      }),
    [agentCommand, agentQueued, completion, primaryUrl]
  );

  const onMenuChoose = useCallback(
    (value: CompletionActionId) => {
      switch (value) {
        case "issues":
          if (primaryUrl) {
            actions.openUrl(primaryUrl);
            actions.track("open-sentry");
            setNote("Opened Sentry in your browser.");
          }
          break;
        case "agent":
          if (agentCommand) {
            if (agentQueued) {
              store.dequeuePostExitAction(agentCommand);
              actions.track("agent-plugin-unqueued");
              setNote("");
            } else {
              store.queuePostExitAction(agentCommand);
              actions.track("agent-plugin-queued");
              setNote(`Queued — ${agentCommand} runs when you finish.`);
            }
          }
          break;
        case "finish":
          onDismiss();
          break;
        default:
          break;
      }
    },
    [actions, agentCommand, agentQueued, onDismiss, primaryUrl, store]
  );

  // `o` opens the first-error link directly (the hint next to it), separate
  // from arrowing to "Open my Issues feed" in the menu.
  const openShortcuts = useMemo<ShortcutBinding[]>(
    () =>
      primaryUrl
        ? [
            {
              key: "o",
              action: "open",
              priority: 45,
              match: (input, key) =>
                !key.ctrl && (input === "o" || input === "O"),
              run: () => {
                actions.openUrl(primaryUrl);
                actions.track("open-sentry");
                setNote("Opened Sentry in your browser.");
              },
            },
          ]
        : [],
    [actions, primaryUrl]
  );
  useInkShortcuts("completion-open", openShortcuts);

  return (
    <Box
      flexDirection="column"
      height={rows}
      marginLeft={getInkFrameMargin(columns, width)}
      width={width}
    >
      <Box flexDirection="column" flexGrow={1} paddingTop={1}>
        <CompletionHeader completion={completion} />
        <CompletionWhatWeSetUp completion={completion} />
        <CompletionFirstError completion={completion} verified={verified} />
        <CompletionMenu
          choices={menuChoices}
          onChoose={onMenuChoose}
          onDismiss={onDismiss}
        />
        {note ? (
          <Box flexShrink={0} marginTop={1} paddingX={1}>
            <Box flexShrink={0} width={3}>
              <Text color={COLOR_SUCCESS}>
                {ICON_BY_SEVERITY.success.glyph}
              </Text>
            </Box>
            <Text color={MUTED} wrap="truncate">
              {note}
            </Text>
          </Box>
        ) : null}
        <Box flexGrow={1} />
        <ShortcutFooter color={MUTED_DIM} />
        <FeedbackBanner cliVersion={cliVersion} width={width} />
      </Box>
    </Box>
  );
}

/**
 * A `<marker> Title` section header. The `marker` numbers the two action
 * sections ("1", "2") so they read as a sequence; the passive "what we set up"
 * context passes a blank marker. Colour encodes importance: omit `color` for
 * the focal steps (bright white), `MUTED_DIM` for the supporting context.
 */
function CompletionSectionHeader({
  color,
  marker,
  title,
}: {
  color?: string;
  marker: string;
  title: string;
}): React.ReactNode {
  return (
    <Box flexShrink={0}>
      <Box flexShrink={0} width={3}>
        <Text bold color={color}>
          {marker}
        </Text>
      </Box>
      <Text bold color={color}>
        {title}
      </Text>
    </Box>
  );
}

/**
 * The ✔ headline. When there's a feature list to show it flows straight into
 * it ("Sentry is set up in <project>, with:"), so the list needs no separate
 * subheader. The ✔ shares the glyph column with the numbered steps below.
 */
function CompletionHeader({
  completion,
}: {
  completion: WizardCompletion | null;
}): React.ReactNode {
  const projectName = completion?.projectName ?? "your project";
  const hasSetup =
    (completion?.featureBlurbs.length ?? 0) > 0 ||
    (completion?.features.length ?? 0) > 0;
  return (
    <Box flexShrink={0} paddingX={1}>
      <Box flexShrink={0} width={3}>
        <Text bold color={COLOR_SUCCESS}>
          {ICON_BY_SEVERITY.success.glyph}
        </Text>
      </Box>
      <Text bold>Sentry is set up in </Text>
      <Text bold color={ACCENT}>
        {projectName}
      </Text>
      {hasSetup ? <Text color={MUTED}>, with:</Text> : null}
    </Box>
  );
}

/** "4 files changed" — the quiet footnote under the feature list. */
function completionSummaryText(
  completion: WizardCompletion | null
): string | null {
  const n = completion?.changedFileCount ?? 0;
  if (n <= 0) {
    return null;
  }
  return `${n} ${n === 1 ? "file" : "files"} changed`;
}

/**
 * The project info under the header's "…set up in <project>, with:" lead-in:
 * one small line per enabled feature (AI blurbs when available, plain labels
 * otherwise) plus a changed-files footnote.
 */
function CompletionWhatWeSetUp({
  completion,
}: {
  completion: WizardCompletion | null;
}): React.ReactNode {
  if (!completion) {
    return null;
  }
  const { featureBlurbs, features } = completion;
  const footnote = completionSummaryText(completion);
  if (featureBlurbs.length === 0 && features.length === 0 && !footnote) {
    return null;
  }
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      <Box flexDirection="column" paddingLeft={3}>
        {featureBlurbs.length > 0
          ? featureBlurbs.map(({ label, blurb }) => (
              <Box flexDirection="row" flexShrink={0} key={label}>
                <Box flexShrink={0} width={20}>
                  <Text bold color={MUTED}>
                    {label}
                  </Text>
                </Box>
                <Box flexShrink={1}>
                  <Text color={MUTED} wrap="wrap">
                    {blurb}
                  </Text>
                </Box>
              </Box>
            ))
          : features.map((label) => (
              <Text bold color={MUTED} key={label}>
                {label}
              </Text>
            ))}
        {footnote ? <Text color={MUTED_DIM}>{footnote}</Text> : null}
      </Box>
    </Box>
  );
}

/** Copy for the first-error section, by state. */
function firstErrorInstruction(
  verified: boolean,
  startCommand: string | undefined
): string {
  if (verified) {
    return "Your app is already sending events — here's the one you just sent:";
  }
  if (startCommand) {
    return `Run ${startCommand}, make it throw an error, and it lands here:`;
  }
  return "Run your app, make it throw an error, and it lands here:";
}

/** The one thing to do next — the emphasized (ACCENT) section. */
function CompletionFirstError({
  completion,
  verified,
}: {
  completion: WizardCompletion | null;
  verified: boolean;
}): React.ReactNode {
  const primaryUrl = completion?.verification.eventUrl ?? completion?.issuesUrl;
  const instruction = firstErrorInstruction(verified, completion?.startCommand);
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1} paddingX={1}>
      <CompletionSectionHeader
        marker="1"
        title={verified ? "First event received" : "See your first error"}
      />
      <Box flexDirection="column" paddingLeft={3}>
        <Text color={MUTED} wrap="truncate">
          {instruction}
        </Text>
        {primaryUrl ? (
          <Box>
            <Text color={COLOR_SUCCESS}>{"→ "}</Text>
            <Text color={COLOR_INFO} wrap="truncate">
              {primaryUrl}
            </Text>
            <Text color={MUTED_DIM}>{"  (o) to open"}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

/** Option rows for the completion menu: a bold ▶ cursor (bigger than the
 * prompt's small ▸ so the selection is unmistakable), bold label on focus. */
function CompletionOptions<T extends string>({
  choices,
  highlighted,
}: {
  choices: ChoiceRow<T>[];
  highlighted: number;
}): React.ReactNode {
  // Indent so the cursor sits directly under the section title (e.g. below the
  // "N" of "Next steps"), not under the section's number marker.
  return (
    <Box flexDirection="column" paddingLeft={3}>
      {choices.map((choice, index) => {
        const isCursor = index === highlighted;
        return (
          <Box
            flexDirection="row"
            height={1}
            key={choice.value}
            overflow="hidden"
          >
            <Box flexShrink={0} width={3}>
              <Text bold color={ACCENT}>
                {isCursor ? ICONS.triangleRight : " "}
              </Text>
            </Box>
            <Text bold={isCursor}>{choice.label}</Text>
            {choice.hint ? <Text color={MUTED}> {choice.hint}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

/** Optional next steps — a de-emphasized (MUTED) `◇` section + driveable menu. */
function CompletionMenu({
  choices,
  onChoose,
  onDismiss,
}: {
  choices: ChoiceRow<CompletionActionId>[];
  onChoose: (value: CompletionActionId) => void;
  onDismiss: () => void;
}): React.ReactNode {
  const highlighted = useChoiceNavigation<CompletionActionId>({
    choices,
    onCancel: onDismiss,
    onChoose,
    scope: "completion-menu",
  });
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1} paddingX={1}>
      <CompletionSectionHeader marker="2" title="Next steps" />
      <CompletionOptions choices={choices} highlighted={highlighted} />
    </Box>
  );
}

// ─────────────────────────── Intro Screen ────────────────────────────

function IntroScreen({
  bannerRows,
  logs,
  prompt,
  spinner,
  width,
}: {
  bannerRows: BannerLine[];
  logs: LogEntry[];
  prompt: ActivePrompt | null;
  spinner: SpinnerState;
  width: number;
}): React.ReactNode {
  const welcomePrompt = prompt?.kind === "welcome" ? prompt : null;
  const options = welcomePrompt?.options ?? DEFAULT_WELCOME_OPTIONS;
  const bodyWidth = Math.min(width, 84);
  // Use the provided banner rows if they fit; if they're too wide for the
  // current terminal, downsize to the widest variant that fits so the banner
  // never wraps on resize. An explicitly-empty list means "no banner".
  const banner =
    bannerRows.length === 0 || bannerLinesWidth(bannerRows) <= bodyWidth
      ? bannerRows
      : bannerLinesForWidth(bodyWidth);
  // Center the banner as one unit; centering rows separately shifts shorter rows.
  const bannerWidth = bannerLinesWidth(banner);

  return (
    <Box alignItems="center" flexDirection="column" width={bodyWidth}>
      <Box
        flexDirection="column"
        marginBottom={welcomePrompt ? 2 : 1}
        width={bannerWidth}
      >
        {banner.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional banner rows
          <Text color={row.color} key={i}>
            {row.content}
          </Text>
        ))}
      </Box>
      {welcomePrompt ? (
        <Box alignItems="center" flexDirection="column" marginBottom={1}>
          {options.body.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </Box>
      ) : null}
      {welcomePrompt ? (
        <>
          <Box marginBottom={2}>
            <Text bold>{options.punchline}</Text>
          </Box>
          <WelcomeActions prompt={welcomePrompt} />
        </>
      ) : null}
      {welcomePrompt ? null : (
        <IntroPreflightContent logs={logs} prompt={prompt} spinner={spinner} />
      )}
    </Box>
  );
}

function WelcomeActions({
  prompt,
}: {
  prompt: Extract<ActivePrompt, { kind: "welcome" }>;
}): React.ReactNode {
  const choices = useMemo<ChoiceRow<"continue" | "cancel">[]>(
    () => [
      { value: "continue", label: "Continue" },
      { value: "cancel", label: "Cancel" },
    ],
    []
  );
  const onChoose = useCallback(
    (value: "continue" | "cancel") => {
      if (value === "cancel") {
        prompt.resolve(null);
        return;
      }
      prompt.resolve("continue");
    },
    [prompt]
  );
  const highlighted = useChoiceNavigation({
    choices,
    onChoose,
    onCancel: () => prompt.resolve(null),
    scope: "welcome-screen",
  });

  return (
    <Box>
      <ActionList centered choices={choices} highlighted={highlighted} />
    </Box>
  );
}

function IntroPreflightContent({
  logs,
  prompt,
  spinner,
}: {
  logs: LogEntry[];
  prompt: ActivePrompt | null;
  spinner: SpinnerState;
}): React.ReactNode {
  const visibleLogs = prompt ? [] : logs.slice(-5);
  const hasContent =
    visibleLogs.length > 0 || spinner.active || prompt !== null;

  if (!hasContent) {
    return null;
  }

  const promptContent = prompt ? (
    <Box alignItems="center" width="100%">
      <PromptArea
        alignment="center"
        occupiedRows={spinner.active ? 2 : 0}
        prompt={prompt}
      />
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1} width="100%">
      {visibleLogs.length > 0 ? (
        <Box alignItems="center" flexDirection="column">
          {visibleLogs.map((log) => (
            <LogLine entry={log} key={log.id} />
          ))}
        </Box>
      ) : null}
      {spinner.active ? (
        <Box justifyContent="center">
          <SpinnerRow state={spinner} />
        </Box>
      ) : null}
      {promptContent}
    </Box>
  );
}

function LogLine({ entry }: { entry: LogEntry }): React.ReactNode {
  const { glyph, color } = ICON_BY_SEVERITY[entry.severity];
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexShrink={0} width={3}>
        <Text color={color}>{glyph}</Text>
      </Box>
      <Text wrap="truncate">{entry.text}</Text>
    </Box>
  );
}

function SpinnerRow({ state }: { state: SpinnerState }): React.ReactNode {
  return (
    <Box flexDirection="row" flexShrink={0} marginTop={1}>
      <Box flexShrink={0} width={3}>
        <Text color={PRIMARY}>
          <Spinner type="dots" />
        </Text>
      </Box>
      <Text>{state.message}</Text>
    </Box>
  );
}

// ──────────────────────────── Tip Panel ──────────────────────────────

function TipPanel({ tipIndex }: { tipIndex: number }): React.ReactNode {
  const tip = SENTRY_TIPS[tipIndex % SENTRY_TIPS.length] as SentryTip;
  const total = SENTRY_TIPS.length;
  const oneIndexed = (tipIndex % total) + 1;
  return (
    <Box
      borderColor={MUTED_DIM}
      borderStyle="round"
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
    >
      <Text bold color={MUTED}>
        {ICONS.diamondOpen} Did you know?
      </Text>
      <Box height={1} />
      <Text bold color={ACCENT}>
        {tip.title}
      </Text>
      <Text wrap="wrap">{tip.body}</Text>
      <Box height={1} />
      <Box justifyContent="flex-end">
        <Text color={MUTED_DIM}>
          {oneIndexed}/{total}
        </Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────── Learn Panel ──────────────────────────────

function LearnPanel({
  learnState,
}: {
  learnState: LearnState;
}): React.ReactNode {
  const block = LEARN_SEQUENCE[learnState.blockIndex];
  if (!block) {
    return null;
  }
  // Pad short blocks to BLOCK_LINE_COUNT so height stays fixed.
  const lines = block.lines.slice(0, BLOCK_LINE_COUNT);
  const padding = Math.max(0, BLOCK_LINE_COUNT - lines.length);
  return (
    <Box
      borderColor={MUTED_DIM}
      borderStyle="round"
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={ACCENT}>
          {block.title}
        </Text>
        <Text color={MUTED_DIM}>
          {learnState.blockIndex + 1}/{LEARN_SEQUENCE.length}
        </Text>
      </Box>
      <Box height={1} />
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional content lines
        <Text key={i}>{line || " "}</Text>
      ))}
      {Array.from({ length: padding }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional filler
        <Text key={`p${i}`}> </Text>
      ))}
    </Box>
  );
}

// ────────────────────────── Progress Panel ────────────────────────────

function ProgressPanel({ steps }: { steps: StepEntry[] }): React.ReactNode {
  const completedCount = steps.filter(
    (entry) => entry.status === "completed"
  ).length;
  const totalCount = steps.length;

  const headerRight = totalCount > 0 ? `${completedCount}/${totalCount}` : "";
  const badgeColor = completedCount === totalCount ? COLOR_SUCCESS : MUTED;

  return (
    <Box
      borderColor={MUTED_DIM}
      borderStyle="round"
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={ACCENT}>
          {ICONS.diamondOpen} Tasks
        </Text>
        {headerRight ? <Text color={badgeColor}>{headerRight}</Text> : null}
      </Box>
      <Box height={1} />
      {steps.length === 0 ? (
        <Box gap={1}>
          <Text color={PRIMARY}>
            <Spinner type="dots" />
          </Text>
          <Text>Analyzing project...</Text>
        </Box>
      ) : null}
      {steps.map((entry) => (
        <ProgressRow entry={entry} key={entry.id} />
      ))}
    </Box>
  );
}

function ProgressRow({ entry }: { entry: StepEntry }): React.ReactNode {
  const { boldLabel, glyph, glyphColor, labelColor } = progressStyle(entry);
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexShrink={0} width={3}>
        {entry.status === "in_progress" ? (
          <ActiveTaskGlyph />
        ) : (
          <Text color={glyphColor}>{glyph}</Text>
        )}
      </Box>
      <Text bold={boldLabel} color={labelColor}>
        {entry.label}
      </Text>
    </Box>
  );
}

function ActiveTaskGlyph(): React.ReactNode {
  const [isFilled, setIsFilled] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setIsFilled((current) => !current);
    }, ACTIVE_TASK_PULSE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return isFilled ? (
    <Text color={PRIMARY}>{ICONS.triangleRight}</Text>
  ) : (
    <Text color={PRIMARY}>{ICONS.triangleRightOutline}</Text>
  );
}

function progressStyle(entry: StepEntry): {
  boldLabel: boolean;
  glyph: string;
  glyphColor: string;
  labelColor?: string;
} {
  if (entry.status === "in_progress") {
    return {
      boldLabel: true,
      glyph: ICONS.triangleRight,
      glyphColor: PRIMARY,
    };
  }
  if (entry.status === "completed") {
    return {
      boldLabel: false,
      glyph: ICONS.squareFilled,
      glyphColor: COLOR_SUCCESS,
      labelColor: MUTED,
    };
  }
  if (entry.status === "failed") {
    return {
      boldLabel: true,
      glyph: "\u2716",
      glyphColor: COLOR_ERROR,
      labelColor: COLOR_ERROR,
    };
  }
  if (entry.status === "skipped") {
    return {
      boldLabel: false,
      glyph: "\u25CC",
      glyphColor: MUTED_DIM,
      labelColor: MUTED,
    };
  }
  return {
    boldLabel: false,
    glyph: ICONS.squareOpen,
    glyphColor: MUTED,
  };
}

// ─────────────────────────── Files Panel ──────────────────────────────

function FilesPanel({
  filesRead,
  maxRows,
  hasActivePrompt,
}: {
  filesRead: FileReadEntry[];
  maxRows: number;
  hasActivePrompt: boolean;
}): React.ReactNode {
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [offset, setOffset] = useState(0);

  const tree = buildReadTree(filesRead);
  const rows = flattenTree(tree);
  const totalRows = rows.length;

  const viewport = Math.max(1, maxRows - 1);
  const canScroll = totalRows > viewport;

  const maxOffset = Math.max(0, totalRows - viewport);
  const effectiveOffset = pinnedToBottom ? 0 : Math.min(offset, maxOffset);

  const sliceEnd = totalRows - effectiveOffset;
  const sliceStart = Math.max(0, sliceEnd - viewport);
  const visible = rows.slice(sliceStart, sliceEnd);

  const prevTotalRef = useRef(totalRows);
  useEffect(() => {
    const prev = prevTotalRef.current;
    prevTotalRef.current = totalRows;
    if (pinnedToBottom) {
      return;
    }
    const newMax = Math.max(0, totalRows - viewport);
    if (totalRows > prev) {
      setOffset((current) => Math.min(newMax, current + (totalRows - prev)));
    } else if (totalRows < prev) {
      setOffset((current) => Math.min(current, newMax));
    }
  }, [totalRows, viewport, pinnedToBottom]);

  const fileShortcuts = useMemo<ShortcutBinding[]>(() => {
    if (!canScroll) {
      return [];
    }
    return [
      {
        key: "\u2191\u2193",
        action: "scroll",
        priority: 30,
        match: (_input, key) => key.upArrow || key.downArrow,
        run: (_input, key) => {
          if (key.upArrow) {
            setPinnedToBottom(false);
            setOffset((current) => Math.min(maxOffset, current + 1));
            return;
          }
          setOffset((current) => {
            const next = Math.max(0, current - 1);
            if (next === 0) {
              setPinnedToBottom(true);
            }
            return next;
          });
        },
      },
      {
        key: "page",
        action: "scroll",
        priority: 31,
        showInFooter: false,
        match: (_input, key) => key.pageUp || key.pageDown,
        run: (_input, key) => {
          if (key.pageUp) {
            setPinnedToBottom(false);
            setOffset((current) => Math.min(maxOffset, current + viewport));
            return;
          }
          setOffset((current) => {
            const next = Math.max(0, current - viewport);
            if (next === 0) {
              setPinnedToBottom(true);
            }
            return next;
          });
        },
      },
      {
        key: "home/end",
        action: "jump",
        priority: 32,
        showInFooter: false,
        match: (_input, key) => key.home || key.end,
        run: (_input, key) => {
          if (key.home) {
            setPinnedToBottom(false);
            setOffset(maxOffset);
            return;
          }
          setPinnedToBottom(true);
          setOffset(0);
        },
      },
    ];
  }, [canScroll, maxOffset, viewport]);
  useInkShortcuts("files-panel", fileShortcuts, {
    isActive: !hasActivePrompt && canScroll,
  });

  if (filesRead.length === 0) {
    return null;
  }

  const analyzedCount = filesRead.filter(
    (entry) => entry.status === "analyzed"
  ).length;
  const padding = Math.max(0, viewport - visible.length);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box justifyContent="space-between">
        <Text bold color={MUTED}>
          Files analyzed
        </Text>
        <Text color={MUTED_DIM}>
          {pinnedToBottom ? "" : "\u2191 "}
          {analyzedCount}/{filesRead.length}
        </Text>
      </Box>
      <Box height={1} />
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          {visible.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional read-tree rows
            <ReadTreeLine key={`r${i}`} row={row} />
          ))}
          {Array.from({ length: padding }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional filler
            <Text key={`p${i}`}> </Text>
          ))}
        </Box>
        {canScroll ? (
          <Scrollbar
            offset={effectiveOffset}
            totalRows={totalRows}
            viewport={viewport}
          />
        ) : null}
      </Box>
    </Box>
  );
}

function Scrollbar({
  offset,
  totalRows,
  viewport,
}: {
  offset: number;
  totalRows: number;
  viewport: number;
}): React.ReactNode {
  const maxOff = Math.max(1, totalRows - viewport);
  const thumbSize = Math.max(1, Math.floor((viewport * viewport) / totalRows));
  const trackSpan = Math.max(1, viewport - thumbSize);
  const thumbStart = Math.round(((maxOff - offset) / maxOff) * trackSpan);
  const cells = Array.from({ length: viewport }, (_v, i) => {
    const inThumb = i >= thumbStart && i < thumbStart + thumbSize;
    return inThumb ? "\u2588" : ICONS.verticalLine;
  });
  return (
    <Box flexDirection="column" flexShrink={0} marginLeft={1}>
      {cells.map((cell, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional scrollbar
        <Text color={MUTED_DIM} key={i}>
          {cell}
        </Text>
      ))}
    </Box>
  );
}

function ReadTreeLine({ row }: { row: FileTreeRow }): React.ReactNode {
  if (row.kind === "directory") {
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Text color={MUTED_DIM}>{`${row.prefix}${row.branch} `}</Text>
        <Text>{row.label}</Text>
      </Box>
    );
  }
  const { glyph, glyphColor, labelColor } = readStatusStyle(row.status);
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={MUTED_DIM}>{`${row.prefix}${row.branch} `}</Text>
      <Text color={glyphColor}>{`${glyph} `}</Text>
      <Text color={labelColor}>{row.label}</Text>
    </Box>
  );
}

function readStatusStyle(status: FileTreeRow["status"]): {
  glyph: string;
  glyphColor: string;
  labelColor?: string;
} {
  if (status === "reading") {
    return { glyph: "\u25D0", glyphColor: PRIMARY };
  }
  return { glyph: "\u2713", glyphColor: COLOR_SUCCESS, labelColor: MUTED };
}

// ────────────────────────────── Summary ───────────────────────────────

function SummaryPanel({
  summary,
}: {
  summary: WizardSummary;
}): React.ReactNode {
  return (
    <Box
      borderBottom={false}
      borderColor={MUTED_DIM}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      paddingTop={1}
    >
      {summary.fields.length > 0 ? (
        <Box flexDirection="column" flexShrink={0}>
          {summary.fields.map((field) => (
            <Box flexDirection="row" flexShrink={0} key={field.label}>
              <Box flexShrink={0} width={14}>
                <Text color={MUTED}>{field.label}</Text>
              </Box>
              <Text bold>{field.value}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {summary.featureBlurbs !== undefined &&
      summary.featureBlurbs.length > 0 ? (
        <Box flexDirection="column" flexShrink={0} marginTop={1}>
          <Text bold color={MUTED}>
            Here&apos;s what we set up
          </Text>
          {summary.featureBlurbs.map(({ label, blurb }) => (
            <Box flexDirection="row" flexShrink={0} key={label}>
              <Box flexShrink={0} width={22}>
                <Text bold color={PRIMARY}>
                  {label}
                </Text>
              </Box>
              <Box flexShrink={1}>
                <Text color={MUTED} wrap="wrap">
                  {blurb}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
      {summary.changedFiles !== undefined && summary.changedFiles.length > 0 ? (
        <ChangedFilesTree files={summary.changedFiles} />
      ) : null}
    </Box>
  );
}

function ChangedFilesTree({
  files,
}: {
  files: { action: string; path: string }[];
}): React.ReactNode {
  const tree = buildFileTree(files);
  const treeRows = flattenTree(tree);
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1}>
      <Text bold color={MUTED}>
        Changed files
      </Text>
      {treeRows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional tree rows
        <FileTreeLine key={i} row={row} />
      ))}
    </Box>
  );
}

function FileTreeLine({ row }: { row: FileTreeRow }): React.ReactNode {
  if (row.kind === "directory") {
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Text color={MUTED_DIM}>{`${row.prefix}${row.branch} `}</Text>
        <Text>{row.label}</Text>
      </Box>
    );
  }
  const { glyph, color } = changedFileStyle(row.action ?? "modify");
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={MUTED_DIM}>{`${row.prefix}${row.branch} `}</Text>
      <Text color={color}>{`${glyph} `}</Text>
      <Text>{row.label}</Text>
    </Box>
  );
}

function changedFileStyle(action: string): { glyph: string; color: string } {
  if (action === "create") {
    return { glyph: "+", color: COLOR_SUCCESS };
  }
  if (action === "delete") {
    return { glyph: "\u2212", color: COLOR_ERROR };
  }
  return { glyph: "~", color: COLOR_WARN };
}

// ─────────────────────────────── Prompts ──────────────────────────────

type PromptAlignment = "start" | "center";
type SelectPromptOptionData = Extract<
  ActivePrompt,
  { kind: "select" }
>["options"][number];
type MultiSelectPromptOptionData = Extract<
  ActivePrompt,
  { kind: "multiselect" }
>["options"][number];
type CenteredSelectLayout = {
  labelWidth: number;
  width: number;
};

function getCenteredSelectLayout(
  options: SelectPromptOptionData[]
): CenteredSelectLayout {
  const labelWidth = Math.max(
    0,
    ...options.map((option) => stringWidth(option.label))
  );
  const hintWidth = Math.max(
    0,
    ...options.map((option) => stringWidth(option.hint ?? ""))
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
  maxVisible: number
): readonly [number, number] {
  const normalizedTotal = Math.max(0, Math.floor(totalCount));
  if (normalizedTotal === 0) {
    return [0, 0];
  }

  const viewportSize = Math.min(
    normalizedTotal,
    Math.max(1, Math.floor(maxVisible))
  );
  const normalizedHighlight = Math.min(
    normalizedTotal - 1,
    Math.max(0, Math.floor(highlighted))
  );
  const centeredStart = normalizedHighlight - Math.floor(viewportSize / 2);
  const start = Math.min(
    normalizedTotal - viewportSize,
    Math.max(0, centeredStart)
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

function getPromptOptionLimit(
  args: Parameters<typeof getPromptOptionCapacity>[0]
): number {
  return Math.max(1, getPromptOptionCapacity(args));
}

/**
 * Locked rows stay pinned, while the selectable viewport budgets for its
 * tallest wrapped description so changing the cursor cannot overflow it.
 */
function getMultiSelectLayout({
  options,
  availableRows,
  terminalColumns,
  alignment,
}: {
  options: MultiSelectPromptOptionData[];
  availableRows: number;
  terminalColumns: number;
  alignment: PromptAlignment;
}): { maxVisibleOptions: number; showDescriptions: boolean } {
  const descriptionWidth = Math.max(
    1,
    getPromptContentWidth(terminalColumns, alignment) -
      (alignment === "center" ? 4 : 5)
  );
  const optionRows = options.map((option) => {
    if (!option.description) {
      return 1;
    }
    const descriptionRows = wrapAnsi(option.description, descriptionWidth, {
      hard: true,
      trim: false,
      wordWrap: true,
    }).split("\n").length;
    return 1 + descriptionRows;
  });
  const lockedRows = optionRows.reduce(
    (total, rows, index) => (options[index]?.locked ? total + rows : total),
    0
  );
  const selectableRows = optionRows.filter(
    (_rows, index) => !options[index]?.locked
  );
  const tallestSelectable = Math.max(1, ...selectableRows);
  if (lockedRows + tallestSelectable > availableRows) {
    const lockedCount = options.filter((option) => option.locked).length;
    return {
      maxVisibleOptions: Math.max(1, availableRows - lockedCount),
      showDescriptions: false,
    };
  }
  return {
    maxVisibleOptions: Math.max(
      1,
      Math.floor(Math.max(0, availableRows - lockedRows) / tallestSelectable)
    ),
    showDescriptions: true,
  };
}

function getPromptContentWidth(
  terminalColumns: number,
  alignment: PromptAlignment
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
  alignment: PromptAlignment
): number {
  const leadingWidth = alignment === "start" ? 3 : 0;
  return Math.max(
    1,
    getPromptContentWidth(terminalColumns, alignment) - leadingWidth
  );
}

function getPromptDetailsRows(
  details: readonly PromptDetail[],
  availableWidth: number
): number {
  return details.reduce(
    (rows, detail) => rows + getPromptTextRows(detail.text, availableWidth),
    0
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
    terminalRows - WORKFLOW_ACTIVITY_RESERVED_ROWS - occupiedRows
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
      availableRows - titleRows - minimumOptionRows
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
      `(${"9".repeat(countDigits)}/${"9".repeat(countDigits)})`
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
  rowBudget: number
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
  rowBudget: number
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
  rowBudget: number
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
  footer?: PromptDetail
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
        getPromptTextRows(detail.text, detailWidth)
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
        detailWidth
      )
    : 0;
  const itemRowBudget = Math.max(
    0,
    maxVisibleRows - detailLayout.headerRows - footerRows - indicatorRows
  );
  const [windowStart, setWindowStart] = useState(0);
  const normalizedStart = normalizeDetailWindowStart(
    windowStart,
    detailLayout.items.length
  );
  const windowEnd = getDetailWindowEnd(
    normalizedStart,
    detailLayout.itemRows,
    itemRowBudget
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
          moveWindow(start, detailLayout.itemRows, itemRowBudget)
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
        <Box gap={1} justifyContent="center" width="100%">
          <Text bold>{promptTitle}</Text>
          {position}
        </Box>
        {detailRows}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
      <Box>
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
  prompt: Extract<ActivePrompt, { kind: "select" }>;
}): React.ReactNode {
  const { columns, rows } = useInkFrameSize();
  const hasStructuredCopy =
    (prompt.details?.length ?? 0) > 0 || prompt.footer !== undefined;
  if (alignment === "start" && hasStructuredCopy) {
    const layout = getStructuredSelectLayout({
      alignment,
      details: prompt.details ?? [],
      footer: prompt.footer,
      occupiedRows,
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
    occupiedRows,
    messageRows,
  });
  const optionLimit = Math.max(1, optionCapacity);
  const minimumVisibleOptions =
    (prompt.details?.length ?? 0) > 0 && prompt.options.length <= 2
      ? prompt.options.length
      : 1;
  const maxVisibleDetailRows = Math.max(
    0,
    messageRows - 1 - Math.max(0, minimumVisibleOptions - optionCapacity)
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

function MultiSelectPromptArea({
  alignment,
  occupiedRows,
  prompt,
}: {
  alignment: PromptAlignment;
  occupiedRows: number;
  prompt: Extract<ActivePrompt, { kind: "multiselect" }>;
}): React.ReactNode {
  const { columns, rows } = useInkFrameSize();
  const promptMessage = [
    prompt.message,
    ...(prompt.details ?? []).map((detail) => detail.text),
    ...((prompt.details?.length ?? 0) > 0 ? [""] : []),
  ].join("\n");
  const messageRows = getPromptMessageRows({
    message: promptMessage,
    terminalColumns: columns,
    alignment,
    kind: prompt.kind,
    totalCount: prompt.options.length,
  });
  const availableRows = getPromptOptionLimit({
    terminalRows: rows,
    alignment,
    kind: prompt.kind,
    occupiedRows,
    messageRows,
  });
  const multiselectLayout = getMultiSelectLayout({
    options: prompt.options,
    availableRows,
    terminalColumns: columns,
    alignment,
  });
  return (
    <MultiSelectPrompt
      alignment={alignment}
      maxVisibleOptions={multiselectLayout.maxVisibleOptions}
      prompt={prompt}
      showDescriptions={multiselectLayout.showDescriptions}
    />
  );
}

function PromptArea({
  alignment = "start",
  occupiedRows = 0,
  prompt,
}: {
  alignment?: PromptAlignment;
  occupiedRows?: number;
  prompt: ActivePrompt;
}): React.ReactNode {
  if (prompt.kind === "select") {
    return (
      <SelectPromptArea
        alignment={alignment}
        occupiedRows={occupiedRows}
        prompt={prompt}
      />
    );
  }
  if (prompt.kind === "multiselect") {
    return (
      <MultiSelectPromptArea
        alignment={alignment}
        occupiedRows={occupiedRows}
        prompt={prompt}
      />
    );
  }
  if (prompt.kind === "confirm") {
    return <ConfirmPrompt alignment={alignment} prompt={prompt} />;
  }
  return null;
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
  prompt: Extract<ActivePrompt, { kind: "select" }>;
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
    prompt.footer
  );
  const { columns } = useInkFrameSize();
  const centeredLayout = isCentered
    ? getCenteredSelectLayout(prompt.options)
    : null;
  const centeredOptionsWidth = centeredLayout
    ? Math.min(centeredLayout.width, getPromptContentWidth(columns, alignment))
    : undefined;
  const totalCount = prompt.options.length;
  const [highlighted, setHighlighted] = useState<number>(() =>
    Math.min(Math.max(prompt.initialIndex, 0), Math.max(0, totalCount - 1))
  );
  const [windowStart, windowEnd] = getOptionWindow(
    totalCount,
    highlighted,
    maxVisibleOptions
  );
  const visibleOptions = prompt.options.slice(windowStart, windowEnd);
  const isWindowed = visibleOptions.length < totalCount;

  const shortcuts = useMemo<ShortcutBinding[]>(
    () => [
      {
        key: "\u2191\u2193",
        action: "navigate",
        priority: 40,
        match: (_input, key) => key.upArrow || key.downArrow,
        run: (_input, key) => {
          if (key.upArrow) {
            setHighlighted((idx) => (idx === 0 ? totalCount - 1 : idx - 1));
            return;
          }
          setHighlighted((idx) => (idx + 1) % totalCount);
        },
      },
      ...(detailShortcut ? [detailShortcut] : []),
      {
        key: "enter",
        action: "confirm",
        priority: 42,
        match: (_input, key) => key.return,
        run: () => {
          const current = prompt.options[highlighted];
          if (current) {
            prompt.resolve(current.value);
          }
        },
      },
      {
        key: "esc",
        action: "cancel",
        priority: 43,
        match: (input, key) => key.escape || (key.ctrl && input === "c"),
        run: () => prompt.resolve(null),
      },
    ],
    [detailShortcut, highlighted, prompt, totalCount]
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
        promptTitle={promptTitle}
        totalCount={totalCount}
        visiblePromptDetails={visiblePromptDetails}
      />
      <Box
        justifyContent={isCentered ? "center" : "flex-start"}
        width={promptWidth}
      >
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
              />
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

function SelectPromptOptionRow({
  centered,
  centeredLabelWidth,
  isCursor,
  option,
}: {
  centered: boolean;
  centeredLabelWidth?: number;
  isCursor: boolean;
  option: SelectPromptOptionData;
}): React.ReactNode {
  if (centered) {
    return (
      <Box flexDirection="row" height={1} overflow="hidden" width="100%">
        <Box flexShrink={0} width={2}>
          <Text color={ACCENT}>{isCursor ? ICONS.triangleRight : " "}</Text>
        </Box>
        <Box flexShrink={0} width={centeredLabelWidth}>
          <Text bold={isCursor}>{option.label}</Text>
        </Box>
        {option.hint !== undefined && option.hint !== "" ? (
          <Text color={MUTED}> {option.hint}</Text>
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      <Box flexShrink={0} width={3}>
        <Text color={ACCENT}>{isCursor ? ICONS.triangleRight : " "}</Text>
      </Box>
      <Text bold={isCursor}>{option.label}</Text>
      {option.hint !== undefined && option.hint !== "" ? (
        <Text color={MUTED}> {option.hint}</Text>
      ) : null}
    </Box>
  );
}

function ConfirmPrompt({
  alignment,
  prompt,
}: {
  alignment: PromptAlignment;
  prompt: Extract<ActivePrompt, { kind: "confirm" }>;
}): React.ReactNode {
  const isCentered = alignment === "center";
  const promptWidth = isCentered ? "100%" : undefined;
  const shortcuts = useMemo<ShortcutBinding[]>(
    () => [
      {
        key: "y/n",
        action: "answer",
        priority: 40,
        match: (input) =>
          input === "y" || input === "Y" || input === "n" || input === "N",
        run: (input) => prompt.resolve(input === "y" || input === "Y"),
      },
      {
        key: "enter",
        action: "default",
        priority: 41,
        showInFooter: false,
        match: (_input, key) => key.return,
        run: () => prompt.resolve(prompt.initialValue),
      },
      {
        key: "esc",
        action: "cancel",
        priority: 42,
        showInFooter: false,
        match: (input, key) => key.escape || (key.ctrl && input === "c"),
        run: () => prompt.resolve(null),
      },
    ],
    [prompt]
  );
  useInkShortcuts("confirm-prompt", shortcuts);

  const yLabel = prompt.initialValue ? "Y" : "y";
  const nLabel = prompt.initialValue ? "n" : "N";

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      width={promptWidth}
    >
      {isCentered ? (
        <Box gap={1} justifyContent="center" width="100%">
          <Text bold>{prompt.message}</Text>
          <Text color={MUTED_DIM}>
            ({yLabel}/{nLabel})
          </Text>
        </Box>
      ) : (
        <Box>
          <Box flexShrink={0} width={3}>
            <Text bold color={ACCENT}>
              {ICONS.diamondOpen}
            </Text>
          </Box>
          <Text bold>{prompt.message}</Text>
          <Text color={MUTED_DIM}>
            ({yLabel}/{nLabel})
          </Text>
        </Box>
      )}
    </Box>
  );
}

function MultiSelectPrompt({
  alignment,
  maxVisibleOptions,
  prompt,
  showDescriptions,
}: {
  alignment: PromptAlignment;
  maxVisibleOptions: number;
  prompt: Extract<ActivePrompt, { kind: "multiselect" }>;
  showDescriptions: boolean;
}): React.ReactNode {
  const isCentered = alignment === "center";
  const promptWidth = isCentered ? "100%" : undefined;
  const promptTitle = prompt.message;
  const promptDetails = prompt.details ?? [];
  const lockedOptions = useMemo(
    () => prompt.options.filter((option) => option.locked),
    [prompt.options]
  );
  const selectableOptions = useMemo(
    () => prompt.options.filter((option) => !option.locked),
    [prompt.options]
  );
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set([
        ...prompt.initialSelected,
        ...prompt.options
          .filter((option) => option.locked)
          .map((option) => option.value),
      ])
  );
  const [highlighted, setHighlighted] = useState<number>(() => {
    const firstUnselected = selectableOptions.findIndex(
      (option) => !prompt.initialSelected.includes(option.value)
    );
    return Math.max(0, firstUnselected);
  });
  const totalCount = prompt.options.length;
  const selectableCount = selectableOptions.length;
  const [windowStart, windowEnd] = getOptionWindow(
    selectableCount,
    highlighted,
    maxVisibleOptions
  );
  const visibleOptions = selectableOptions.slice(windowStart, windowEnd);
  const isWindowed = visibleOptions.length < selectableCount;

  const toggleAt = useCallback(
    (idx: number) => {
      const current = selectableOptions[idx];
      if (!current) {
        return;
      }
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(current.value)) {
          next.delete(current.value);
        } else {
          next.add(current.value);
        }
        return next;
      });
    },
    [selectableOptions]
  );

  const commit = useCallback(() => {
    if (prompt.required && selected.size === 0) {
      return;
    }
    const ordered = prompt.options
      .map((option) => option.value)
      .filter((value) => selected.has(value));
    prompt.resolve(ordered);
  }, [prompt, selected]);

  const shortcuts = useMemo<ShortcutBinding[]>(
    () => [
      {
        key: "\u2191\u2193",
        action: "navigate",
        priority: 40,
        match: (_input, key) => key.upArrow || key.downArrow,
        run: (_input, key) => {
          if (selectableCount === 0) {
            return;
          }
          if (key.upArrow) {
            setHighlighted((idx) =>
              idx === 0 ? selectableCount - 1 : idx - 1
            );
            return;
          }
          setHighlighted((idx) => (idx + 1) % selectableCount);
        },
      },
      {
        key: "space",
        action: "toggle",
        priority: 41,
        match: (input) => input === " ",
        run: () => toggleAt(highlighted),
      },
      {
        key: "a",
        action: "all",
        priority: 42,
        match: (input) => input === "a",
        run: () => {
          setSelected((prev) => {
            const lockedValues = lockedOptions.map((option) => option.value);
            const allSelectableSelected = selectableOptions.every((option) =>
              prev.has(option.value)
            );
            if (allSelectableSelected) {
              return new Set(lockedValues);
            }
            return new Set(prompt.options.map((option) => option.value));
          });
        },
      },
      {
        key: "enter",
        action: "continue",
        priority: 43,
        match: (_input, key) => key.return,
        run: commit,
      },
      {
        key: "esc",
        action: "cancel",
        priority: 44,
        match: (input, key) => key.escape || (key.ctrl && input === "c"),
        run: () => prompt.resolve(null),
      },
    ],
    [
      commit,
      highlighted,
      lockedOptions,
      prompt,
      selectableCount,
      selectableOptions,
      toggleAt,
    ]
  );
  useInkShortcuts("multiselect-prompt", shortcuts);
  const shortcutText = `↑↓ move ${ICONS.bullet} space toggle ${ICONS.bullet} a all ${ICONS.bullet} enter continue`;
  const selectedCount = isWindowed
    ? `${selected.size}/${totalCount} selected ${ICONS.bullet} ${highlighted + 1}/${selectableCount}`
    : `${selected.size}/${totalCount}`;

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      width={promptWidth}
    >
      {isCentered ? (
        <Box flexDirection="column" width="100%">
          <Box justifyContent="center" width="100%">
            <Text bold>{promptTitle}</Text>
          </Box>
          <PromptDetails alignment={alignment} details={promptDetails} />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Box>
              <Box flexShrink={0} width={3}>
                <Text bold color={ACCENT}>
                  {ICONS.diamondOpen}
                </Text>
              </Box>
              <Text bold>{promptTitle}</Text>
            </Box>
            <Text color={ACCENT}>{selectedCount}</Text>
          </Box>
          <PromptDetails alignment={alignment} details={promptDetails} />
        </Box>
      )}
      <Box
        flexDirection="column"
        marginTop={(prompt.details?.length ?? 0) > 0 ? 1 : 0}
        width={promptWidth}
      >
        {lockedOptions.map((option) => (
          <MultiSelectPromptOptionRow
            centered={isCentered}
            isCursor={false}
            isSelected={true}
            key={option.value}
            option={option}
            showDescription={showDescriptions}
          />
        ))}
        {visibleOptions.map((option, visibleIndex) => {
          const idx = windowStart + visibleIndex;
          const isSelected = selected.has(option.value);
          const isCursor = idx === highlighted;
          return (
            <MultiSelectPromptOptionRow
              centered={isCentered}
              isCursor={isCursor}
              isSelected={isSelected}
              key={option.value}
              option={option}
              showDescription={showDescriptions}
            />
          );
        })}
      </Box>
      {isCentered ? (
        <Box
          alignItems="center"
          flexDirection="column"
          marginTop={1}
          width="100%"
        >
          <Text color={MUTED_DIM}>{shortcutText}</Text>
          <Text color={ACCENT}>{selectedCount}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={MUTED_DIM}>{shortcutText}</Text>
        </Box>
      )}
    </Box>
  );
}

function getLockedOptionHint(
  option: MultiSelectPromptOptionData,
  availableWidth: number
): string {
  if (!option.locked) {
    return "";
  }
  const lockedHint = " (always included)";
  const optionHint = option.hint ? ` ${option.hint}` : "";
  return stringWidth(`${option.label}${optionHint}${lockedHint}`) <=
    availableWidth
    ? lockedHint
    : "";
}

function MultiSelectOptionLabel({
  isCursor,
  lockedHint,
  option,
}: {
  isCursor: boolean;
  lockedHint: string;
  option: MultiSelectPromptOptionData;
}): React.ReactNode {
  const labelColor = option.locked ? MUTED : undefined;
  return (
    <>
      <Text bold={isCursor} color={labelColor}>
        {option.label}
      </Text>
      {option.hint ? <Text color={MUTED}> {option.hint}</Text> : null}
      <Text color={MUTED_DIM}>{lockedHint}</Text>
    </>
  );
}

function MultiSelectPromptOptionRow({
  centered,
  isCursor,
  isSelected,
  option,
  showDescription,
}: {
  centered: boolean;
  isCursor: boolean;
  isSelected: boolean;
  option: MultiSelectPromptOptionData;
  showDescription: boolean;
}): React.ReactNode {
  const marker = isSelected ? ICONS.squareFilled : ICONS.squareOpen;
  const markerColor = isSelected ? COLOR_SUCCESS : MUTED;
  const { columns } = useInkFrameSize();
  const alignment = centered ? "center" : "start";
  const optionContentWidth =
    getPromptContentWidth(columns, alignment) - (centered ? 4 : 5);
  const lockedHint = getLockedOptionHint(option, optionContentWidth);
  const descriptionIndent = 5;
  const visibleDescription = showDescription ? option.description : undefined;
  if (centered) {
    return (
      <Box flexDirection="column" width="100%">
        <Box
          flexDirection="row"
          height={1}
          justifyContent="center"
          overflow="hidden"
          width="100%"
        >
          <Text color={ACCENT}>
            {isCursor ? `${ICONS.triangleRight} ` : "  "}
          </Text>
          <Text color={markerColor}>{marker} </Text>
          <MultiSelectOptionLabel
            isCursor={isCursor}
            lockedHint={lockedHint}
            option={option}
          />
        </Box>
        {visibleDescription ? (
          <Box justifyContent="center" width="100%">
            <Text color={MUTED}>{visibleDescription}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" height={1} overflow="hidden">
        <Box flexShrink={0} width={3}>
          <Text color={ACCENT}>{isCursor ? ICONS.triangleRight : " "}</Text>
        </Box>
        <Text color={markerColor}>{marker} </Text>
        <MultiSelectOptionLabel
          isCursor={isCursor}
          lockedHint={lockedHint}
          option={option}
        />
      </Box>
      {visibleDescription ? (
        <Box paddingLeft={descriptionIndent} width="100%">
          <Text color={MUTED}>{visibleDescription}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Mount the wizard App component via Ink and return the Ink instance.
 *
 * This function must live inside the sidecar so it uses the same
 * `react` and `ink` copies as the App's hooks. Importing ink/react
 * separately in the main bundle and calling `ink.render()` from
 * there would create a second React instance, causing "Invalid hook
 * call" errors at runtime. By centralising the mount call here,
 * only one copy of ink + react exists.
 */
export function mountApp(
  store: WizardStore,
  options: {
    exitOnCtrlC: boolean;
    patchConsole: boolean;
    stdin?: import("node:tty").ReadStream;
  }
): {
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  rerender: (node: React.ReactNode) => void;
  clear: () => void;
} {
  return inkRender(createElement(App, { store }), options);
}
