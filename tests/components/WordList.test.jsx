import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WordList from "../../src/components/WordList";

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
