import { Box, Text, useWindowSize } from "ink";
import { Component, type ReactNode } from "react";
import stringWidth from "string-width";
import { useShortcutHints } from "./ink-shortcuts.js";

const MIN_FRAME_WIDTH = 80;
const MAX_FRAME_WIDTH = 120;

export type FrameTab = {
  id: string;
  label: string;
};

export function getInkFrameWidth(terminalColumns: number): number {
  if (terminalColumns < MIN_FRAME_WIDTH) {
    return terminalColumns;
  }
  return Math.min(MAX_FRAME_WIDTH, terminalColumns);
}

export function getInkFrameMargin(
  terminalColumns: number,
  frameWidth: number
): number {
  return Math.max(0, Math.floor((terminalColumns - frameWidth) / 2));
}

export function useInkFrameSize(): { columns: number; rows: number } {
  return useWindowSize();
}

export function StatusHistory({
  messages,
  borderColor,
  currentColor,
  historyColor,
  currentGlyph,
  historyGlyph,
}: {
  messages: string[];
  borderColor: string;
  currentColor: string;
  historyColor: string;
  currentGlyph: string;
  historyGlyph: string;
}): React.ReactNode {
  return (
    <Box
      borderBottom={false}
      borderColor={borderColor}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      borderTop
      flexDirection="column"
      overflow="hidden"
      paddingX={1}
    >
      {messages.map((message, index, allMessages) => {
        const isLatest = index === allMessages.length - 1;
        let glyph = historyGlyph;
        let color = historyColor;
        if (isLatest) {
          glyph = currentGlyph;
          color = currentColor;
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional status messages
          <Text color={color} key={index}>
            {glyph} {message}
          </Text>
        );
      })}
    </Box>
  );
}

export function TabFooter({
  tabs,
  activeTab,
  activeColor,
  inactiveColor,
  activeGlyph,
}: {
  tabs: FrameTab[];
  activeTab: number;
  activeColor: string;
  inactiveColor: string;
  activeGlyph: string;
}): React.ReactNode {
  return (
    <Box gap={1} height={1} paddingX={1}>
      {tabs.map((tab, index) => {
        const isActive = index === activeTab;
        let color = inactiveColor;
        let glyph = " ";
        if (isActive) {
          color = activeColor;
          glyph = activeGlyph;
        }
        return (
          <Box key={tab.id}>
            <Text bold={isActive} color={color}>
              {glyph} {tab.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function ShortcutFooter({ color }: { color: string }): React.ReactNode {
  const hints = useShortcutHints();
  const { columns } = useWindowSize();
  const availableWidth = Math.max(0, getInkFrameWidth(columns) - 2);
  let usedWidth = 0;
  const visibleHints: typeof hints = [];
  for (const hint of hints) {
    const gapWidth = visibleHints.length === 0 ? 0 : 2;
    const hintWidth = stringWidth(`${hint.key} ${hint.action}`);
    if (usedWidth + gapWidth + hintWidth > availableWidth) {
      continue;
    }
    usedWidth += gapWidth + hintWidth;
    visibleHints.push(hint);
  }

  return (
    <Box height={1} paddingX={1}>
      {visibleHints.map((hint, index) => (
        <Box
          key={`${hint.key}-${hint.action}`}
          marginRight={index < visibleHints.length - 1 ? 2 : 0}
        >
          <Text bold color={color}>
            {hint.key}
          </Text>
          <Text dimColor> {hint.action}</Text>
        </Box>
      ))}
    </Box>
  );
}

type RenderErrorBoundaryProps = {
  children: ReactNode;
  errorColor: string;
};

type RenderErrorBoundaryState = {
  message: string | null;
};

export class InitRenderBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  override state: RenderErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: Error): RenderErrorBoundaryState {
    return { message: error.message || "Unknown render error" };
  }

  override render(): ReactNode {
    if (this.state.message) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={this.props.errorColor}>
            Sentry init UI hit a rendering error.
          </Text>
          <Text dimColor>{this.state.message}</Text>
        </Box>
      );
    }

    return this.props.children;
  }
}
