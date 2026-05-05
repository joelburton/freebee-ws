import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Letters from "../../src/components/Letters";

describe("Letters", () => {
  it("renders center first, then outers in source order", () => {
    const { container } = render(
      <Letters
        letters={["B", "D", "E", "I", "N", "T"]}
        center="R"
        onLetterClick={() => {}}
      />,
    );
    const buttons = container.querySelectorAll(".Letter");
    expect(buttons).toHaveLength(7);
    expect(buttons[0]).toHaveTextContent("R");
    expect(buttons[0]).toHaveClass("Letter-isCenter");
    expect([...buttons].slice(1).map((b) => b.textContent)).toEqual([
      "B",
      "D",
      "E",
      "I",
      "N",
      "T",
    ]);
    for (const b of [...buttons].slice(1)) {
      expect(b).not.toHaveClass("Letter-isCenter");
    }
  });

  it("invokes onLetterClick with the clicked letter", async () => {
    const user = userEvent.setup();
    const onLetterClick = vi.fn();
    render(
      <Letters
        letters={["B", "D", "E", "I", "N", "T"]}
        center="R"
        onLetterClick={onLetterClick}
      />,
    );
    await user.click(screen.getByText("R"));
    await user.click(screen.getByText("B"));
    expect(onLetterClick).toHaveBeenNthCalledWith(1, "R");
    expect(onLetterClick).toHaveBeenNthCalledWith(2, "B");
  });
});
