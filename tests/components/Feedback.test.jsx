import { render, screen } from "@testing-library/react";
import Feedback from "../../src/components/Feedback";

describe("Feedback", () => {
  it("renders nothing visible when message is empty", () => {
    const { container } = render(<Feedback message="" type={null} />);
    expect(container.querySelector(".Feedback-message")).toBeNull();
  });

  it("applies success class for success type", () => {
    render(<Feedback message="+5" type="success" />);
    const el = screen.getByText("+5");
    expect(el).toHaveClass("Feedback-message");
    expect(el).toHaveClass("Feedback-success");
  });

  it("applies warning class for warning type", () => {
    render(<Feedback message="Already found!" type="warning" />);
    expect(screen.getByText("Already found!")).toHaveClass(
      "Feedback-warning",
    );
  });

  it("applies error class for error type", () => {
    render(<Feedback message="Not a valid word" type="error" />);
    expect(screen.getByText("Not a valid word")).toHaveClass(
      "Feedback-error",
    );
  });
});
