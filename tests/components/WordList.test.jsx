import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// After a click, the popover renders the word too — getByText("tribe")
// would find both the list item and the popover. Always click the
// list item (the first match).
function clickWord(word) {
  return userEvent.setup().click(screen.getAllByText(word)[0]);
}

const fetchDefinitionMock = vi.fn();
vi.mock("../../src/api.js", () => ({
  fetchDefinition: (word) => fetchDefinitionMock(word),
}));

const { default: WordList } = await import("../../src/components/WordList");

beforeEach(() => {
  fetchDefinitionMock.mockReset();
  // Desktop by default; phone-suite tests override.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

describe("WordList", () => {
  it("shows empty placeholder when no words", () => {
    render(<WordList found={[]} />);
    expect(screen.getByText(/No words yet/i)).toBeInTheDocument();
  });

  it("renders found words sorted alphabetically", () => {
    render(<WordList found={["zebra", "apple", "mango"]} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "apple",
      "mango",
      "zebra",
    ]);
  });

  it("bolds pangrams (7 distinct letters) and not non-pangrams", () => {
    render(<WordList found={["trident", "interbred"]} />);
    expect(screen.getByText("interbred")).toHaveClass("WordList-pangram");
    expect(screen.getByText("trident")).not.toHaveClass("WordList-pangram");
  });

  it("when `all` is provided, renders every word and marks unfound ones", () => {
    render(
      <WordList
        found={["tribe"]}
        all={["tribe", "trident", "interbred"]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "interbred",
      "tribe",
      "trident",
    ]);
    expect(screen.getByText("tribe")).not.toHaveClass("WordList-unfound");
    expect(screen.getByText("trident")).toHaveClass("WordList-unfound");
  });

  it("renders word text in the finder's color and adds the recent-underline class only for recently-added words", () => {
    const { container } = render(
      <WordList
        found={["tribe", "rebind"]}
        wordColors={{ tribe: "#1976d2", rebind: "#1976d2" }}
        recentlyFound={new Set(["tribe"])}
      />,
    );
    const items = Array.from(container.querySelectorAll(".WordList li"));
    const tribe = items.find((li) => li.textContent.startsWith("tribe"));
    const rebind = items.find((li) => li.textContent.startsWith("rebind"));
    // jsdom normalizes hex to rgb for inline styles.
    expect(tribe.style.color).toBe("rgb(25, 118, 210)");
    expect(rebind.style.color).toBe("rgb(25, 118, 210)");
    // Only the recent one carries the underline marker.
    expect(tribe.classList.contains("WordList-recent")).toBe(true);
    expect(rebind.classList.contains("WordList-recent")).toBe(false);
  });

  it("no recent-underline when wordColors is missing (solo)", () => {
    const { container } = render(
      <WordList
        found={["tribe"]}
        recentlyFound={new Set(["tribe"])}
      />,
    );
    expect(container.querySelector(".WordList-recent")).toBeNull();
  });

  it("marks words in bonusSet with a bonus dot", () => {
    const { container } = render(
      <WordList
        found={["tribe", "rebind"]}
        bonusSet={new Set(["rebind"])}
      />,
    );
    const items = Array.from(container.querySelectorAll(".WordList li"));
    const tribe = items.find((li) => li.textContent.startsWith("tribe"));
    const rebind = items.find((li) => li.textContent.startsWith("rebind"));
    expect(tribe.querySelector(".WordList-bonus")).toBeNull();
    expect(rebind.querySelector(".WordList-bonus")).not.toBeNull();
  });

  it("when revealed, includes bonus finds alongside the reveal list", () => {
    const { container } = render(
      <WordList
        found={["tribe", "rebind"]}
        all={["tribe", "trident"]}
        bonusSet={new Set(["rebind"])}
      />,
    );
    const items = Array.from(container.querySelectorAll(".WordList li"));
    const text = items.map((li) => {
      const span = li.querySelector(".WordList-bonus");
      if (span) span.remove();
      return li.textContent;
    });
    expect(text).toEqual(["rebind", "tribe", "trident"]);
    const items2 = Array.from(container.querySelectorAll(".WordList li"));
    const rebind = items2.find((li) => li.textContent.startsWith("rebind"));
    expect(rebind.classList.contains("WordList-unfound")).toBe(false);
  });

  it("hides pagination (but reserves the row) when words fit on one page", () => {
    const { container } = render(<WordList found={["a", "b", "c"]} />);
    // The nav row is always rendered so the box height doesn't shift;
    // it's just visually hidden + buttons disabled when only one page.
    const nav = container.querySelector(".WordList-nav");
    expect(nav).not.toBeNull();
    expect(nav.getAttribute("aria-hidden")).toBe("true");
    expect(nav.classList.contains("is-hidden")).toBe(true);
    expect(screen.getByLabelText("Previous page")).toBeDisabled();
    expect(screen.getByLabelText("Next page")).toBeDisabled();
  });

  it("paginates when there are more words than fit on a page", async () => {
    const user = userEvent.setup();
    // 49 unique words; pass pageSize=48 explicitly so the test doesn't
    // depend on layout measurement (jsdom has no real layout).
    const words = Array.from({ length: 49 }, (_, i) =>
      String.fromCharCode(97 + Math.floor(i / 26)) +
      String.fromCharCode(97 + (i % 26)) +
      "word",
    );
    render(<WordList found={words} pageSize={48} />);

    // page 1: 48 items
    expect(screen.getAllByRole("listitem")).toHaveLength(48);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    // prev disabled at start
    const prev = screen.getByLabelText("Previous page");
    const next = screen.getByLabelText("Next page");
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();

    // go to page 2: 1 item remaining
    await user.click(next);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Next page")).toBeDisabled();
    expect(screen.getByLabelText("Previous page")).not.toBeDisabled();

    // back to page 1
    await user.click(screen.getByLabelText("Previous page"));
    expect(screen.getAllByRole("listitem")).toHaveLength(48);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("respects an explicit pageSize override", () => {
    render(<WordList found={["a", "b", "c", "d", "e"]} pageSize={2} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });
});

describe("WordList: definition popover", () => {
  it("clicking a word fetches and displays the definition", async () => {
    fetchDefinitionMock.mockResolvedValue("a small social group");
    render(<WordList found={["tribe", "trident"]} />);
    await userEvent.setup().click(screen.getByText("tribe"));
    expect(fetchDefinitionMock).toHaveBeenCalledWith("tribe");
    await screen.findByRole("dialog", { name: /Definition of tribe/i });
    expect(screen.getByText("a small social group")).toBeInTheDocument();
  });

  it("shows an immediate '…' placeholder before the fetch resolves", async () => {
    let resolve;
    fetchDefinitionMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<WordList found={["tribe"]} />);
    await userEvent.setup().click(screen.getByText("tribe"));
    const dialog = await screen.findByRole("dialog", {
      name: /Definition of tribe/i,
    });
    expect(dialog).toHaveTextContent("…");
    await act(async () => {
      resolve("the definition");
    });
    await waitFor(() =>
      expect(dialog).toHaveTextContent("the definition"),
    );
  });

  it("falls back to 'No definition available' when fetch returns null", async () => {
    fetchDefinitionMock.mockResolvedValue(null);
    render(<WordList found={["tribe"]} />);
    await userEvent.setup().click(screen.getByText("tribe"));
    expect(
      await screen.findByText(/No definition available/i),
    ).toBeInTheDocument();
  });

  it("clicking the same word again dismisses the popover (toggle)", async () => {
    fetchDefinitionMock.mockResolvedValue("definition");
    render(<WordList found={["tribe"]} />);
    await clickWord("tribe");
    await screen.findByRole("dialog");
    await clickWord("tribe");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicking the popover itself dismisses it", async () => {
    fetchDefinitionMock.mockResolvedValue("definition");
    render(<WordList found={["tribe"]} />);
    await clickWord("tribe");
    const dialog = await screen.findByRole("dialog");
    await userEvent.setup().click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicking a different word swaps in its definition", async () => {
    fetchDefinitionMock.mockImplementation(async (w) => `definition of ${w}`);
    render(<WordList found={["tribe", "trident"]} />);
    await clickWord("tribe");
    await screen.findByText("definition of tribe");
    await clickWord("trident");
    await screen.findByRole("dialog", { name: /Definition of trident/i });
    expect(screen.getByText("definition of trident")).toBeInTheDocument();
    expect(screen.queryByText("definition of tribe")).not.toBeInTheDocument();
  });

  it("a stale racing fetch doesn't overwrite a newer click's popover", async () => {
    // Click "tribe" — slow fetch. Click "trident" — fast. The "tribe"
    // fetch resolves last; the trident popover stays.
    let resolveTribe;
    fetchDefinitionMock.mockImplementation((w) => {
      if (w === "tribe") return new Promise((r) => (resolveTribe = r));
      if (w === "trident") return Promise.resolve("trident def");
      return Promise.resolve(null);
    });
    render(<WordList found={["tribe", "trident"]} />);
    await clickWord("tribe");
    await clickWord("trident");
    await screen.findByText("trident def");
    await act(async () => {
      resolveTribe("late tribe def");
    });
    expect(screen.getByText("trident def")).toBeInTheDocument();
    expect(screen.queryByText("late tribe def")).not.toBeInTheDocument();
  });

  it("auto-dismisses after the visible window", async () => {
    // Fake timers must be installed BEFORE the click so the WordList's
    // setTimeout for auto-dismiss is captured by the fake clock. The
    // fetch promise resolves via microtasks, which run regardless.
    vi.useFakeTimers();
    try {
      fetchDefinitionMock.mockResolvedValue("def");
      render(<WordList found={["tribe"]} />);
      fireEvent.click(screen.getByText("tribe"));
      // Flush microtasks for the fetch resolution + state updates.
      await act(async () => {});
      expect(screen.queryByRole("dialog")).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(4900);
      });
      expect(screen.queryByRole("dialog")).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("phone breakpoint: clicks are no-ops (no popover, no fetch)", async () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    render(<WordList found={["tribe"]} />);
    await clickWord("tribe");
    expect(fetchDefinitionMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders sigil-wrapped definition fragments italicized", async () => {
    fetchDefinitionMock.mockResolvedValue("a friend [n FRIENDS] {pal=n}");
    render(<WordList found={["tribe"]} />);
    await clickWord("tribe");
    const dialog = await screen.findByRole("dialog");
    const ems = dialog.querySelectorAll("em");
    expect(Array.from(ems).map((e) => e.textContent)).toEqual([
      "n FRIENDS",
      "pal=n",
    ]);
    expect(dialog.textContent).toContain("[");
    expect(dialog.textContent).toContain("]");
  });
});
