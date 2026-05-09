import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import beeLogo from "../bee-logo.svg";
import {
  clearSavedState,
  loadSavedBuilder,
  loadSavedName,
  loadSavedState,
  saveSavedBuilder,
  saveSavedName,
  saveState,
  takeBanner,
} from "../components/storage";
import { fetchGame, parseTime, postJson } from "../api";
import {
  BuilderField,
  CustomLettersForm,
  NameField,
  TimerControls,
} from "../components/setupFields";

export default function HomePage() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One-shot banner from a redirect (e.g. /g/<bad>). takeBanner reads
  // and clears in one step, so the lazy initializer captures it on
  // mount without needing an effect.
  const [banner, setBanner] = useState(() => takeBanner());

  // Solo card state.
  const [centerInput, setCenterInput] = useState("");
  const [outerInput, setOuterInput] = useState("");
  const [timerMode, setTimerMode] = useState("none");
  const [countdownInput, setCountdownInput] = useState("5:00");
  // BoardBuilder strategy preference. Persists across visits so a
  // returning player doesn't have to re-pick.
  const [builder, setBuilder] = useState(() => loadSavedBuilder());

  // "Play with friends" — just the host's name. Mode (co-op vs compete),
  // timer, and custom letters all get picked later, in the group's
  // configure step. Defaulted from localStorage so returning players
  // don't re-type their name.
  const [nameInput, setNameInput] = useState(() => loadSavedName());

  // Resume card: validate the saved solo game still exists on the server.
  const [savedGame, setSavedGame] = useState(null);
  // Active tab: "solo" or "friends".
  const [activeTab, setActiveTab] = useState("solo");

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
      // Group with no session yet (assembling/configuring) also isn't
      // a solo candidate.
      if (data.state === "assembling" || data.state === "configuring") return;
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
        builder,
        ...extra,
      });
      saveSavedBuilder(builder);
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

  // Create an empty group, then jump the host into the lobby. Mode and
  // timer aren't picked yet — the host (or any player) chooses them
  // inside the group via "Start setup".
  async function startFriends() {
    const cleanName = nameInput.trim();
    if (!cleanName) return;
    setBusy(true);
    setError("");
    try {
      const data = await postJson("/api/groups", { playerName: cleanName });
      saveSavedName(cleanName);
      saveState({ gameId: data.gameId, playerId: data.playerId });
      navigate(`/g/${data.gameId}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  function continueSaved() {
    if (savedGame) navigate(`/p/${savedGame.gameId}`);
  }

  if (busy) return <div className="App-loading">Loading game…</div>;

  return (
    <div className="App-start">
      <header className="App-header App-header-home">
        <h1>
          <Link to="/">
            <img src={beeLogo} className="BeeTitle-logo" alt="" aria-hidden="true" />
            Freebee
          </Link>
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
          <Tab
            id="tab-solo"
            active={activeTab === "solo"}
            onSelect={() => setActiveTab("solo")}
          >
            Solo
          </Tab>
          <Tab
            id="tab-friends"
            active={activeTab === "friends"}
            onSelect={() => setActiveTab("friends")}
          >
            Play with friends
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
              <BuilderField value={builder} onChange={setBuilder} />
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

          {activeTab === "friends" && (
            <>
              <NameField name={nameInput} onChange={setNameInput} />
              <p className="App-multi-roster-summary">
                You&rsquo;ll get a sharable link. Pick co-op or compete,
                timer, and letters once everyone&rsquo;s arrived.
              </p>
              <div className="App-start-row">
                <button
                  type="button"
                  className="App-start-go"
                  onClick={startFriends}
                  disabled={!nameInput.trim()}
                  aria-label="Create group and invite friends"
                >
                  Go
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {error && <p className="App-start-error">{error}</p>}
    </div>
  );
}

// One tab in the tablist.
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
