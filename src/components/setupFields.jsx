// Shared setup-form fields used by both the home page (solo + new
// "Play with friends" name input) and the in-group configure form on
// the lobby page (mode / timer / custom letters for the next session).

// Required name input. Shows a red label as a soft prompt while empty.
export function NameField({ name, onChange, label = "Your name *" }) {
  return (
    <label
      className={`App-start-field App-start-field-wide${
        name.trim() ? "" : " is-required-empty"
      }`}
    >
      <span>{label}</span>
      <input
        value={name}
        onChange={(e) => onChange(e.target.value.slice(0, 32))}
        spellCheck={false}
        autoComplete="off"
        placeholder="Name"
        required
      />
    </label>
  );
}

// "Center + Outer + Go" form. Parent passes a submit handler that reads
// the inputs from its state.
export function CustomLettersForm({
  center,
  onCenterChange,
  outer,
  onOuterChange,
  onSubmit,
  disabled = false,
  ariaLabel,
}) {
  const lettersOk = center.length === 1 && outer.length === 6;
  return (
    <form className="App-start-row App-start-custom" onSubmit={onSubmit}>
      <label className="App-start-field">
        <span>Center</span>
        <input
          value={center}
          onChange={(e) =>
            onCenterChange(e.target.value.toUpperCase().slice(0, 1))
          }
          maxLength={1}
          spellCheck={false}
          autoComplete="off"
          placeholder="A"
        />
      </label>
      <label className="App-start-field App-start-field-wide">
        <span>Outer</span>
        <input
          value={outer}
          onChange={(e) =>
            onOuterChange(e.target.value.toUpperCase().slice(0, 6))
          }
          maxLength={6}
          spellCheck={false}
          autoComplete="off"
          placeholder="BCDEFG"
        />
      </label>
      <button
        type="submit"
        className="App-start-go"
        disabled={disabled || !lettersOk}
        aria-label={ariaLabel}
      >
        Go
      </button>
    </form>
  );
}

export function TimerControls({
  radioGroup,
  mode,
  onModeChange,
  countdown,
  onCountdownChange,
  disabled = false,
}) {
  // Timer-mode is an infrequent setup choice; keep these fields out of the
  // tab order so Tab from "Name" lands on a Go button rather than silently
  // switching timer mode via the countdown input's onFocus handler. They
  // remain reachable by click.
  return (
    <fieldset className="App-start-timer" disabled={disabled}>
      <legend>Timer</legend>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "none"}
          onChange={() => onModeChange("none")}
          tabIndex={-1}
        />
        No timer
      </label>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "up"}
          onChange={() => onModeChange("up")}
          tabIndex={-1}
        />
        Count up
      </label>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "down"}
          onChange={() => onModeChange("down")}
          tabIndex={-1}
        />
        Countdown
        <input
          type="text"
          className="App-start-countdown"
          value={countdown}
          onChange={(e) => onCountdownChange(e.target.value)}
          onFocus={() => onModeChange("down")}
          placeholder="M:SS"
          size={5}
          aria-label="Countdown duration"
          tabIndex={-1}
        />
      </label>
    </fieldset>
  );
}

// Compete-only end-condition picker: countdown M:SS OR first to one of
// the top three ranks. Same out-of-tab-order treatment as TimerControls.
export function EndCondition({
  radioGroup,
  mode,
  onModeChange,
  countdown,
  onCountdownChange,
  targetRank,
  onTargetRankChange,
  disabled = false,
}) {
  return (
    <fieldset className="App-start-timer" disabled={disabled}>
      <legend>End condition</legend>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "down"}
          onChange={() => onModeChange("down")}
          tabIndex={-1}
        />
        Countdown
        <input
          type="text"
          className="App-start-countdown"
          value={countdown}
          onChange={(e) => onCountdownChange(e.target.value)}
          onFocus={() => onModeChange("down")}
          placeholder="M:SS"
          size={5}
          aria-label="Countdown duration"
          tabIndex={-1}
        />
      </label>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "rank"}
          onChange={() => onModeChange("rank")}
          tabIndex={-1}
        />
        First to
        <select
          value={targetRank}
          onChange={(e) => {
            onModeChange("rank");
            onTargetRankChange(Number(e.target.value));
          }}
          aria-label="Target rank"
          tabIndex={-1}
        >
          {/* Indexes match RANKS in shared/ranks.js. */}
          <option value={4}>Great</option>
          <option value={5}>Amazing</option>
          <option value={6}>Genius</option>
        </select>
      </label>
    </fieldset>
  );
}
