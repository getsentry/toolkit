import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ListTree } from "lucide-react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  EventCommandDialog,
  type CommandNavigationItem,
} from "./event-command-dialog.tsx";

const items = [
  {
    id: "transaction-1",
    type: "transaction",
    text: "{}",
    metadata: {
      title: "GET /api/users/42",
      method: "GET",
      route: "/api/users/42",
    },
  },
];

const navigation: CommandNavigationItem[] = [
  { id: "traces", label: "Traces", icon: ListTree },
];

afterEach(cleanup);

describe("EventCommandDialog", () => {
  test("opens with Meta+K and selects a fuzzy-matched retained event", () => {
    const onSelectItem = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState("");
      return (
        <EventCommandDialog
          enabled
          items={items}
          navigation={navigation}
          open={open}
          query={query}
          onNavigate={vi.fn()}
          onOpenChange={setOpen}
          onQueryChange={setQuery}
          onSelectItem={onSelectItem}
        />
      );
    }

    render(<Harness />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.change(screen.getByPlaceholderText("Search events and views"), {
      target: { value: "usr 42" },
    });
    fireEvent.click(
      screen.getByRole("option", { name: /GET \/api\/users\/42/i }),
    );

    expect(onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "transaction-1" }),
    );
  });

  test("offers Explorer navigation alongside events", () => {
    render(
      <EventCommandDialog
        enabled
        items={[]}
        navigation={navigation}
        open
        query=""
        onNavigate={vi.fn()}
        onOpenChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectItem={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Search this session" }),
    ).not.toBeNull();
    expect(screen.getByRole("option", { name: "Traces" })).not.toBeNull();
  });

  test("closes on Escape and returns focus to the search trigger", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button">
            Search events
          </button>
          <EventCommandDialog
            enabled
            items={items}
            navigation={navigation}
            open={open}
            query=""
            triggerRef={triggerRef}
            onNavigate={vi.fn()}
            onOpenChange={setOpen}
            onQueryChange={vi.fn()}
            onSelectItem={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);
    fireEvent.keyDown(screen.getByPlaceholderText("Search events and views"), {
      key: "Escape",
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Search events" }),
      );
    });
  });

  test("offers the current-view filter when a search query is present", () => {
    const onFilterView = vi.fn();
    render(
      <EventCommandDialog
        enabled
        items={items}
        navigation={navigation}
        open
        query="users"
        onFilterView={onFilterView}
        currentViewLabel="Logs"
        onNavigate={vi.fn()}
        onOpenChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectItem={vi.fn()}
      />,
    );

    expect(screen.getByText("Filter Logs")).not.toBeNull();
    expect(
      screen.getByRole("option", { name: /Filter Logs for “users”/ }),
    ).not.toBeNull();
    expect(onFilterView).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("option", { name: /Filter Logs for “users”/ }),
    );
    expect(onFilterView).toHaveBeenCalledWith("users");
  });
});
