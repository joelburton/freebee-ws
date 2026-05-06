import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  clearSavedState,
  loadSavedState,
  saveState,
  takeBanner,
} from "../components/storage";
import { fetchGame, parseTime, postJson } from "../api";

// Default first-to-rank target. 6 = "Genius" (top of the RANKS array
// in shared/ranks.js). Kept in sync there; if the array changes, also
// update the EndCondition <select> options below.
const DEFAULT_TARGET_RANK = 6;

export default function HomePage() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  // Solo card state.
  const [centerInput, setCenterInput] = useState("");
  const [outerInput, setOuterInput] = useState("");
  const [timerMode, setTimerMode] = useState("none");
  const [countdownInput, setCountdownInput] = useState("5:00");

  // Multiplayer (co-op + compete) shares the player-name input — same
  // concept, no point making the user type their name twice.
  const [nameInput, setNameInput] = useState("");

  // Co-op card state.
  const [centerInputCoop, setCenterInputCoop] = useState("");
  const [outerInputCoop, setOuterInputCoop] = useState("");
  const [timerModeCoop, setTimerModeCoop] = useState("none");
  const [countdownInputCoop, setCountdownInputCoop] = useState("5:00");

  // Compete card state. End condition is "down" (countdown) or "rank"
  // (first-to-rank). `targetRankCompete` is an index into the RANKS
  // array; only used when endMode is "rank".
  const [centerInputCompete, setCenterInputCompete] = useState("");
  const [outerInputCompete, setOuterInputCompete] = useState("");
  const [endModeCompete, setEndModeCompete] = useState("rank");
  const [countdownInputCompete, setCountdownInputCompete] = useState("5:00");
  const [targetRankCompete, setTargetRankCompete] = useState(
    DEFAULT_TARGET_RANK,
  );

  // Resume card: validate the saved solo game still exists on the server.
  const [savedGame, setSavedGame] = useState(null);
  // Active tab: solo | coop | compete.
  const [activeTab, setActiveTab] = useState("solo");

  // One-shot banner from a redirect (e.g. /g/<bad>). Reading sessionStorage
  // is the only way to surface a client-only value after hydration.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBanner(takeBanner());
  }, []);

  useEffect(() => {
    const saved = loadSavedState();
    if (!saved) return;
    let cancelled = false;
    (async () => {
      const data = await fetchGame(saved.gameId);
      if (cancelled) return;
      if (!data) {
        clearSavedState();
        return;
      }
      // Multiplayer saved-state lives behind /g/<id>; not a solo
      // resume candidate.
      if (data.mode === "multi" || data.mode === "compete") return;
      setSavedGame(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function ensureCountdown(mode, inputStr) {
    if (mode !== "down") return 0;
    const s = parseTime(inputStr);
    if (!s) {
      setError("Countdown must be M:SS or MM:SS (e.g. 5:00)");
      return null;
    }
    return s;
  }

  async function startSolo(extra = {}) {
    const countdownSeconds = ensureCountdown(timerMode, countdownInput);
    if (countdownSeconds === null) return;
    setBusy(true);
    setError("");
    try {
      const data = await postJson("/api/games", {
        timerMode,
        countdownSeconds,
        ...extra,
      });
      saveState({ gameId: data.gameId });
      navigate(`/p/${data.gameId}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  function loadRandom() {
    return startSolo();
  }

  function loadCustom(evt) {
    evt.preventDefault();
    return startSolo({
      letters: outerInput.toLowerCase(),
      center: centerInput.toLowerCase(),
    });
  }

  async function startCoop(extra = {}) {
    const cleanName = nameInput.trim();
    if (!cleanName) return;
    const countdownSeconds = ensureCountdown(
      timerModeCoop,
      countdownInputCoop,
    );
    if (countdownSeconds === null) return;
    setBusy(true);
    setError("");
    try {
      const data = await postJson("/api/games", {
        playerName: cleanName,
        timerMode: timerModeCoop,
        countdownSeconds,
        ...extra,
      });
      saveState({ gameId: data.gameId, playerId: data.playerId });
      navigate(`/g/${data.gameId}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  function loadCoopRandom() {
    return startCoop();
  }

  function loadCoopCustom(evt) {
    evt.preventDefault();
    return startCoop({
      letters: outerInputCoop.toLowerCase(),
      center: centerInputCoop.toLowerCase(),
    });
  }

  async function startCompete(extra = {}) {
    const cleanName = nameInput.trim();
    if (!cleanName) return;
    // Compete uses one of two end conditions; the body sent to the
    // server differs accordingly.
    const body = {
      playerName: cleanName,
      mode: "compete",
      ...extra,
    };
    if (endModeCompete === "down") {
      const countdownSeconds = ensureCountdown(
        "down",
        countdownInputCompete,
      );
      if (countdownSeconds === null) return;
      body.timerMode = "down";
      body.countdownSeconds = countdownSeconds;
    } else {
      // First-to-rank: count up so players still see elapsed time.
      body.timerMode = "up";
      body.targetRank = targetRankCompete;
    }
    setBusy(true);
    setError("");
    try {
      const data = await postJson("/api/games", body);
      saveState({ gameId: data.gameId, playerId: data.playerId });
      navigate(`/g/${data.gameId}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  function loadCompeteRandom() {
    return startCompete();
  }

  function loadCompeteCustom(evt) {
    evt.preventDefault();
    return startCompete({
      letters: outerInputCompete.toLowerCase(),
      center: centerInputCompete.toLowerCase(),
    });
  }

  function continueSaved() {
    if (savedGame) navigate(`/p/${savedGame.gameId}`);
  }

  if (busy) return <div className="App-loading">Loading game…</div>;

  return (
    <div className="App-start">
      <header className="App-header App-header-home">
        <h1>
          <Link to="/">Freebee</Link>
        </h1>
      </header>
      {banner && (
        <div className="App-banner App-banner-error" role="alert">
          <span className="App-banner-msg">{banner}</span>
          <button
            type="button"
            className="App-banner-dismiss"
            onClick={() => setBanner(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {savedGame && (
        <section
          className="App-card App-card-resume"
          aria-labelledby="resume-card-title"
        >
          <h2 className="App-card-title" id="resume-card-title">
            Resume
          </h2>
          <button
            type="button"
            className="App-continue"
            onClick={continueSaved}
            aria-label="Resume saved game"
          >
            <span className="App-continue-letters">
              {savedGame.center.toUpperCase()}{" "}
              <span className="App-continue-letters-outer">
                {savedGame.letters.toUpperCase().split("").join(" ")}
              </span>
            </span>
            <span className="App-continue-stats">
              {savedGame.found.length} / {savedGame.words} words ·{" "}
              {savedGame.score} pts
              {savedGame.ended ? " · ended" : ""}
            </span>
          </button>
        </section>
      )}

      <section className="App-card App-card-tabbed">
        <div className="App-tabs" role="tablist" aria-label="New game">
          <Tab id="tab-solo" active={activeTab === "solo"} onSelect={() => setActiveTab("solo")}>
            Solo
          </Tab>
          <Tab id="tab-coop" active={activeTab === "coop"} onSelect={() => setActiveTab("coop")}>
            Co-op
          </Tab>
          <Tab
            id="tab-compete"
            active={activeTab === "compete"}
            onSelect={() => setActiveTab("compete")}
          >
            Compete
          </Tab>
        </div>
        <div
          id="new-game-panel"
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          className="App-card-body"
        >
          {activeTab === "solo" && (
            <>
              <TimerControls
                radioGroup="timerMode-solo"
                mode={timerMode}
                onModeChange={setTimerMode}
                countdown={countdownInput}
                onCountdownChange={setCountdownInput}
              />
              <div className="App-start-row">
                <span className="App-start-row-label">Random letters</span>
                <button
                  type="button"
                  className="App-start-go"
                  onClick={loadRandom}
                  aria-label="Start with random letters"
                >
                  Go
                </button>
              </div>
              <CustomLettersForm
                center={centerInput}
                onCenterChange={setCenterInput}
                outer={outerInput}
                onOuterChange={setOuterInput}
                onSubmit={loadCustom}
                ariaLabel="Start with chosen letters"
              />
            </>
          )}

          {activeTab === "coop" && (
            <>
              <NameField name={nameInput} onChange={setNameInput} />
              <TimerControls
                radioGroup="timerMode-coop"
                mode={timerModeCoop}
                onModeChange={setTimerModeCoop}
                countdown={countdownInputCoop}
                onCountdownChange={setCountdownInputCoop}
              />
              <div className="App-start-row">
                <span className="App-start-row-label">Random letters</span>
                <button
                  type="button"
                  className="App-start-go"
                  onClick={loadCoopRandom}
                  disabled={!nameInput.trim()}
                  aria-label="Start co-op with random letters"
                >
                  Go
                </button>
              </div>
              <CustomLettersForm
                center={centerInputCoop}
                onCenterChange={setCenterInputCoop}
                outer={outerInputCoop}
                onOuterChange={setOuterInputCoop}
                onSubmit={loadCoopCustom}
                disabled={!nameInput.trim()}
                ariaLabel="Start co-op with chosen letters"
              />
            </>
          )}

          {activeTab === "compete" && (
            <>
              <NameField name={nameInput} onChange={setNameInput} />
              <EndCondition
                radioGroup="endMode-compete"
                mode={endModeCompete}
                onModeChange={setEndModeCompete}
                countdown={countdownInputCompete}
                onCountdownChange={setCountdownInputCompete}
                targetRank={targetRankCompete}
                onTargetRankChange={setTargetRankCompete}
              />
              <div className="App-start-row">
                <span className="App-start-row-label">Random letters</span>
                <button
                  type="button"
                  className="App-start-go"
                  onClick={loadCompeteRandom}
                  disabled={!nameInput.trim()}
                  aria-label="Start compete with random letters"
                >
                  Go
                </button>
              </div>
              <CustomLettersForm
                center={centerInputCompete}
                onCenterChange={setCenterInputCompete}
                outer={outerInputCompete}
                onOuterChange={setOuterInputCompete}
                onSubmit={loadCompeteCustom}
                disabled={!nameInput.trim()}
                ariaLabel="Start compete with chosen letters"
              />
            </>
          )}
        </div>
      </section>

      {error && <p className="App-start-error">{error}</p>}
    </div>
  );
}

// One tab in the tablist. Pulled out because the three tabs are
// otherwise identical except for label and active state.
function Tab({ id, active, onSelect, children }) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls="new-game-panel"
      tabIndex={active ? 0 : -1}
      className={`App-tab${active ? " is-active" : ""}`}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

// Required name input shared by Co-op and Compete cards. Shows a red
// label as a soft prompt while empty.
function NameField({ name, onChange }) {
  return (
    <label
      className={`App-start-field App-start-field-wide${
        name.trim() ? "" : " is-required-empty"
      }`}
    >
      <span>Your name *</span>
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

// "Center + Outer + Go" form, shared by all three tabs. The parent
// passes a submit handler that reads the inputs from its state.
function CustomLettersForm({
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

function TimerControls({
  radioGroup,
  mode,
  onModeChange,
  countdown,
  onCountdownChange,
}) {
  // Timer-mode is an infrequent setup choice; keep these fields out of the
  // tab order so Tab from "Name" lands on a Go button rather than silently
  // switching timer mode via the countdown input's onFocus handler. They
  // remain reachable by click.
  return (
    <fieldset className="App-start-timer">
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

// Compete-only end condition picker: countdown M:SS OR first to one of
// the top three ranks. Same out-of-tab-order treatment as TimerControls.
function EndCondition({
  radioGroup,
  mode,
  onModeChange,
  countdown,
  onCountdownChange,
  targetRank,
  onTargetRankChange,
}) {
  return (
    <fieldset className="App-start-timer">
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
