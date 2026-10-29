import type { EventFrame } from "../types.ts";

const _FUNCTION_NAME_FROM_FRAME_CACHE = new WeakMap<EventFrame, string>();
export function getFunctionNameFromFrame(frame: EventFrame): string {
  let result = _FUNCTION_NAME_FROM_FRAME_CACHE.get(frame);
  if (!result) {
    const module =
      frame.module || frame.filename || frame.abs_path || "<unknown>";
    const functionName = frame.function || "<anonymous>";
    const lineNo = frame.lineno ? `:${frame.lineno}` : "";
    const colNo = frame.lineno && frame.colno ? `:${frame.colno}` : "";
    result = `${module}@${functionName}${lineNo}${colNo}`;
    _FUNCTION_NAME_FROM_FRAME_CACHE.set(frame, result);
  }
  return result;
}
