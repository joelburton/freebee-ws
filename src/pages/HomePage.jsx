import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  clearSavedState,
  loadSavedState,
  saveState,
  takeBanner,
} from "../components/storage";
import { fetchGame, parseTime, postJson } from "../api";

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

  // Multi card state.
  const [nameInput, setNameInput] = useState("");
  const [centerInputMulti, setCenterInputMulti] = useState("");
  const [outerInputMulti, setOuterInputMulti] = useState("");
  const [timerModeMulti, setTimerModeMulti] = useState("none");
  const [countdownInputMulti, setCountdownInputMulti] = useState("5:00");

  // Resume card: validate the saved solo game still exists on the server.
  const [savedGame, setSavedGame] = useState(null);
  // Mutually exclusive between solo and multi.
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
      // Multi saved-state lives behind /g/<id>; not a solo resume candidate.
      if (data.mode === "multi") return;
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

  async function startMulti(extra = {}) {
    const cleanName = nameInput.trim();
    if (!cleanName) return;
    const countdownSeconds = ensureCountdown(
      timerModeMulti,
      countdownInputMulti,
    );
    if (countdownSeconds === null) return;
    setBusy(true);
    setError("");
    try {
      const data = await postJson("/api/games", {
        playerName: cleanName,
        timerMode: timerModeMulti,
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

  function loadMultiRandom() {
    return startMulti();
  }

  function loadMultiCustom(evt) {
    evt.preventDefault();
    return startMulti({
      letters: outerInputMulti.toLowerCase(),
      center: centerInputMulti.toLowerCase(),
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
          <button
            type="button"
            role="tab"
            id="tab-solo"
            aria-selected={activeTab === "solo"}
            aria-controls="new-game-panel"
            tabIndex={activeTab === "solo" ? 0 : -1}
            className={`App-tab${activeTab === "solo" ? " is-active" : ""}`}
            onClick={() => setActiveTab("solo")}
          >
            Play solo
          </button>
          <button
            type="button"
            role="tab"
            id="tab-multi"
            aria-selected={activeTab === "multi"}
            aria-controls="new-game-panel"
            tabIndex={activeTab === "multi" ? 0 : -1}
            className={`App-tab${activeTab === "multi" ? " is-active" : ""}`}
            onClick={() => setActiveTab("multi")}
          >
            Play with friends
          </button>
        </div>
        <div
          id="new-game-panel"
          role="tabpanel"
          aria-labelledby={activeTab === "solo" ? "tab-solo" : "tab-multi"}
          className="App-card-body"
        >
          {activeTab === "solo" ? (
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
              <form
                className="App-start-row App-start-custom"
                onSubmit={loadCustom}
              >
                <label className="App-start-field">
                  <span>Center</span>
                  <input
                    value={centerInput}
                    onChange={(e) =>
                      setCenterInput(e.target.value.toUpperCase().slice(0, 1))
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
                    value={outerInput}
                    onChange={(e) =>
                      setOuterInput(e.target.value.toUpperCase().slice(0, 6))
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
                  disabled={
                    centerInput.length !== 1 || outerInput.length !== 6
                  }
                  aria-label="Start with chosen letters"
                >
                  Go
                </button>
              </form>
            </>
          ) : (
            <>
              <label
                className={`App-start-field App-start-field-wide${
                  nameInput.trim() ? "" : " is-required-empty"
                }`}
              >
                <span>Your name *</span>
                <input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value.slice(0, 32))}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="Name"
                  required
                />
              </label>
              <TimerControls
                radioGroup="timerMode-multi"
                mode={timerModeMulti}
                onModeChange={setTimerModeMulti}
                countdown={countdownInputMulti}
                onCountdownChange={setCountdownInputMulti}
              />
              <div className="App-start-row">
                <span className="App-start-row-label">Random letters</span>
                <button
                  type="button"
                  className="App-start-go"
                  onClick={loadMultiRandom}
                  disabled={!nameInput.trim()}
                  aria-label="Start multiplayer with random letters"
                >
                  Go
                </button>
              </div>
              <form
                className="App-start-row App-start-custom"
                onSubmit={loadMultiCustom}
              >
                <label className="App-start-field">
                  <span>Center</span>
                  <input
                    value={centerInputMulti}
                    onChange={(e) =>
                      setCenterInputMulti(
                        e.target.value.toUpperCase().slice(0, 1),
                      )
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
                    value={outerInputMulti}
                    onChange={(e) =>
                      setOuterInputMulti(
                        e.target.value.toUpperCase().slice(0, 6),
                      )
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
                  disabled={
                    !nameInput.trim() ||
                    centerInputMulti.length !== 1 ||
                    outerInputMulti.length !== 6
                  }
                  aria-label="Start multiplayer with chosen letters"
                >
                  Go
                </button>
              </form>
            </>
          )}
        </div>
      </section>

      {error && <p className="App-start-error">{error}</p>}
    </div>
  );
}

function TimerControls({
  radioGroup,
  mode,
  onModeChange,
  countdown,
  onCountdownChange,
}) {
  return (
    <fieldset className="App-start-timer">
      <legend>Timer</legend>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "none"}
          onChange={() => onModeChange("none")}
        />
        No timer
      </label>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "up"}
          onChange={() => onModeChange("up")}
        />
        Count up
      </label>
      <label>
        <input
          type="radio"
          name={radioGroup}
          checked={mode === "down"}
          onChange={() => onModeChange("down")}
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
        />
      </label>
    </fieldset>
  );
}
