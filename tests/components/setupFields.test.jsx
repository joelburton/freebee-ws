import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CustomLettersForm,
  EndCondition,
  NameField,
  TimerControls,
} from "../../src/components/setupFields";

describe("NameField", () => {
  it("calls onChange with each typed character", async () => {
    const onChange = vi.fn();
    render(<NameField name="" onChange={onChange} />);
    const input = screen.getByPlaceholderText("Name");
    const user = userEvent.setup();
    await user.type(input, "Joel");
    // Each onChange call passes the slice up to that point.
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(onChange).toHaveBeenLastCalledWith("l");
  });

  it("truncates input longer than 32 characters", () => {
    const onChange = vi.fn();
    render(<NameField name="" onChange={onChange} />);
    const input = screen.getByPlaceholderText("Name");
    // Simulate a paste-style change event with a long value; the
    // component slices to 32 before calling onChange.
    fireEvent.change(input, { target: { value: "x".repeat(50) } });
    expect(onChange).toHaveBeenCalledWith("x".repeat(32));
  });

  it("flags the wrapping label with is-required-empty when name is blank or whitespace", () => {
    const { rerender } = render(<NameField name="" onChange={() => {}} />);
    const label = screen.getByText("Your name *").closest("label");
    expect(label.classList.contains("is-required-empty")).toBe(true);

    rerender(<NameField name="   " onChange={() => {}} />);
    expect(label.classList.contains("is-required-empty")).toBe(true);

    rerender(<NameField name="Joel" onChange={() => {}} />);
    expect(label.classList.contains("is-required-empty")).toBe(false);
  });

  it("uses a custom label when provided", () => {
    render(<NameField name="" onChange={() => {}} label="Host name" />);
    expect(screen.getByText("Host name")).toBeInTheDocument();
  });
});

describe("CustomLettersForm", () => {
  it("uppercases and limits center to 1 char and outer to 6", async () => {
    const onCenterChange = vi.fn();
    const onOuterChange = vi.fn();
    render(
      <CustomLettersForm
        center=""
        onCenterChange={onCenterChange}
        outer=""
        onOuterChange={onOuterChange}
        onSubmit={() => {}}
      />,
    );
    const center = screen.getByPlaceholderText("A");
    const outer = screen.getByPlaceholderText("BCDEFG");
    const user = userEvent.setup();
    await user.type(center, "r");
    expect(onCenterChange).toHaveBeenLastCalledWith("R");
    await user.type(outer, "bdeint");
    // Each keystroke fires onChange; the last (full string) should be uppercased.
    expect(onOuterChange).toHaveBeenLastCalledWith("T");
  });

  it("Go button is disabled until lettersOk (1 center + 6 outer)", () => {
    const { rerender } = render(
      <CustomLettersForm
        center=""
        onCenterChange={() => {}}
        outer=""
        onOuterChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const go = screen.getByRole("button", { name: "Go" });
    expect(go).toBeDisabled();

    rerender(
      <CustomLettersForm
        center="R"
        onCenterChange={() => {}}
        outer="BDEIN"
        onOuterChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(go).toBeDisabled(); // outer is 5 chars, need 6

    rerender(
      <CustomLettersForm
        center="R"
        onCenterChange={() => {}}
        outer="BDEINT"
        onOuterChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(go).toBeEnabled();
  });

  it("disabled prop overrides the lettersOk gate", () => {
    render(
      <CustomLettersForm
        center="R"
        onCenterChange={() => {}}
        outer="BDEINT"
        onOuterChange={() => {}}
        onSubmit={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
  });

  it("submitting the form fires onSubmit", async () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(
      <CustomLettersForm
        center="R"
        onCenterChange={() => {}}
        outer="BDEINT"
        onOuterChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Go" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("TimerControls", () => {
  function setup(props = {}) {
    const onModeChange = vi.fn();
    const onCountdownChange = vi.fn();
    const utils = render(
      <TimerControls
        radioGroup="t"
        mode="none"
        onModeChange={onModeChange}
        countdown="5:00"
        onCountdownChange={onCountdownChange}
        {...props}
      />,
    );
    return { onModeChange, onCountdownChange, ...utils };
  }

  it("checks the radio matching the `mode` prop", () => {
    const { rerender } = setup({ mode: "up" });
    expect(screen.getByLabelText("Count up")).toBeChecked();
    expect(screen.getByLabelText(/No timer/)).not.toBeChecked();
    rerender(
      <TimerControls
        radioGroup="t"
        mode="down"
        onModeChange={() => {}}
        countdown="5:00"
        onCountdownChange={() => {}}
      />,
    );
    expect(screen.getByLabelText(/Countdown/i, { selector: "input[type='radio']" })).toBeChecked();
  });

  it("clicking a non-selected radio calls onModeChange with the matching mode", async () => {
    // The component is uncontrolled w.r.t. `checked` here — clicking
    // an already-checked radio doesn't fire onChange. Verify by going
    // none → up, then re-rendering and going up → down.
    const { onModeChange, rerender } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Count up"));
    expect(onModeChange).toHaveBeenLastCalledWith("up");
    rerender(
      <TimerControls
        radioGroup="t"
        mode="up"
        onModeChange={onModeChange}
        countdown="5:00"
        onCountdownChange={() => {}}
      />,
    );
    await user.click(
      screen.getByLabelText(/Countdown/, {
        selector: "input[type='radio']",
      }),
    );
    expect(onModeChange).toHaveBeenLastCalledWith("down");
  });

  it("focusing the countdown input switches mode to 'down'", async () => {
    const { onModeChange } = setup();
    const input = screen.getByLabelText("Countdown duration");
    input.focus();
    expect(onModeChange).toHaveBeenLastCalledWith("down");
  });

  it("typing in the countdown input fires onCountdownChange", async () => {
    const { onCountdownChange } = setup({ mode: "down", countdown: "" });
    const input = screen.getByLabelText("Countdown duration");
    await userEvent.setup().type(input, "3");
    expect(onCountdownChange).toHaveBeenLastCalledWith("3");
  });

  it("all radios + countdown input have tabIndex=-1 (deliberate keyboard skip)", () => {
    setup();
    expect(screen.getByLabelText(/No timer/).tabIndex).toBe(-1);
    expect(screen.getByLabelText("Count up").tabIndex).toBe(-1);
    expect(
      screen.getByLabelText(/Countdown/, { selector: "input[type='radio']" })
        .tabIndex,
    ).toBe(-1);
    expect(screen.getByLabelText("Countdown duration").tabIndex).toBe(-1);
  });

  it("disabled prop disables the whole fieldset", () => {
    setup({ disabled: true });
    // Browsers report individual descendants as disabled when the
    // ancestor fieldset is disabled.
    expect(screen.getByLabelText(/No timer/)).toBeDisabled();
    expect(screen.getByLabelText("Countdown duration")).toBeDisabled();
  });
});

describe("EndCondition", () => {
  function setup(props = {}) {
    const onModeChange = vi.fn();
    const onCountdownChange = vi.fn();
    const onTargetRankChange = vi.fn();
    const utils = render(
      <EndCondition
        radioGroup="e"
        mode="rank"
        onModeChange={onModeChange}
        countdown="5:00"
        onCountdownChange={onCountdownChange}
        targetRank={6}
        onTargetRankChange={onTargetRankChange}
        {...props}
      />,
    );
    return { onModeChange, onCountdownChange, onTargetRankChange, ...utils };
  }

  it("changing the rank dropdown bumps mode to 'rank' AND calls onTargetRankChange", async () => {
    const { onModeChange, onTargetRankChange } = setup({ mode: "down" });
    const select = screen.getByLabelText("Target rank");
    await userEvent.setup().selectOptions(select, "5");
    expect(onModeChange).toHaveBeenCalledWith("rank");
    expect(onTargetRankChange).toHaveBeenCalledWith(5);
  });

  it("focusing the countdown input switches mode to 'down'", () => {
    const { onModeChange } = setup({ mode: "rank" });
    screen.getByLabelText("Countdown duration").focus();
    expect(onModeChange).toHaveBeenLastCalledWith("down");
  });

  it("rank dropdown reflects the targetRank prop", () => {
    setup({ targetRank: 4 });
    expect(screen.getByLabelText("Target rank")).toHaveValue("4");
  });

  it("countdown radio + input + rank radio + select all have tabIndex=-1", () => {
    setup();
    expect(
      screen.getByLabelText(/Countdown/, { selector: "input[type='radio']" })
        .tabIndex,
    ).toBe(-1);
    expect(screen.getByLabelText("Countdown duration").tabIndex).toBe(-1);
    expect(
      screen.getByLabelText(/First to/, { selector: "input[type='radio']" })
        .tabIndex,
    ).toBe(-1);
    expect(screen.getByLabelText("Target rank").tabIndex).toBe(-1);
  });
});
