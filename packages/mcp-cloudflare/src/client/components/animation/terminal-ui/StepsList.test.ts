import {
  Children,
  isValidElement,
  type KeyboardEvent,
  type KeyboardEventHandler,
} from "react";
import { describe, expect, it, vi } from "vitest";
import StepsList from "./StepsList";

const steps = Array.from({ length: 6 }, (_, index) => ({
  label: `Step ${index}`,
  description: "",
  startTime: 0,
  pauseMs: null,
}));

describe("StepsList keyboard navigation", () => {
  it.each(["Enter", " "])("restarts from the final step with %j", (key) => {
    const restart = vi.fn();
    const onSelectAction = vi.fn();
    const element = StepsList({
      steps,
      globalIndex: steps.length - 1,
      onSelectAction,
      restart,
    });
    const button = Children.toArray(element.props.children).find(
      (child) => isValidElement(child) && child.type === "button",
    );
    if (!isValidElement<{ onKeyDown: KeyboardEventHandler }>(button)) {
      throw new Error("Step navigation button is missing");
    }

    const preventDefault = vi.fn();
    button.props.onKeyDown({
      key,
      preventDefault,
    } as unknown as KeyboardEvent<HTMLButtonElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(onSelectAction).not.toHaveBeenCalled();
  });
});
