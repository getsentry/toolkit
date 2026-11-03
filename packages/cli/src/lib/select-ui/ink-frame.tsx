/**
 * Width and shortcut-footer helpers shared by the select picker.
 */

import { Box, Text, useWindowSize } from "ink";
import stringWidth from "string-width";
import { useShortcutHints } from "./ink-shortcuts.js";

const MIN_FRAME_WIDTH = 80;
const MAX_FRAME_WIDTH = 120;

export function getInkFrameWidth(terminalColumns: number): number {
  if (terminalColumns < MIN_FRAME_WIDTH) {
    return terminalColumns;
  }
  return Math.min(MAX_FRAME_WIDTH, terminalColumns);
}

export function useInkFrameSize(): { columns: number; rows: number } {
  return useWindowSize();
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
