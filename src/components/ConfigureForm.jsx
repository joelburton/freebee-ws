import { useEffect, useState } from "react";
import { parseTime, postJson } from "../api";
import { CustomLettersForm, EndCondition, TimerControls } from "./setupFields";

const DEFAULT_TARGET_RANK = 6;

// Default form state. Used as the initial draft for owners and as a
// fallback for non-owners until the owner's first /update push arrives.
const DEFAULT_DRAFT = {
  mode: "multi",
  timerMode: "none",
  countdownInput: "5:00",
  endModeCompete: "rank",
  countdownInputCompete: "5:00",
  targetRankCompete: DEFAULT_TARGET_RANK,
  centerInput: "",
  outerInput: "",
};

function mergeDraft(base, override) {
  return { ...base, ...(override || {}) };
}

// In-group configure form. The owner sees an interactive form and posts
// changes to /configure/update so other players' read-only mirrors
// stay in sync. Non-owners pass `readOnly` and the latest draft from
// view.configuring.draft; their state is fully driven by props.
export default function ConfigureForm({
  gameId,
  playerId,
  initialDraft,
  readOnly = false,
  onCancel,
  busy,
  onError,
}) {
  const [draft, setDraft] = useState(() =>
    mergeDraft(DEFAULT_DRAFT, initialDraft),
  );
  const [submitting, setSubmitting] = useState(false);

  // Non-owner: prop-driven. Owner: ignore incoming drafts (their own
  // local state is authoritative; the WS echo of their own update would
  // otherwise clobber a newer in-flight typing change).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (readOnly) setDraft(mergeDraft(DEFAULT_DRAFT, initialDraft));
  }, [readOnly, initialDraft]);

  // Owner: post initial draft once on claim, so non-owners' mirror has
  // something to render before the first user-driven change. Skipped
  // for read-only renders.
  useEffect(() => {
    if (readOnly) return;
    postJson(`/api/games/${gameId}/configure/update`, {
      playerId,
      draft,
    }).catch(() => {
      // Silent — failure here just means non-owners see defaults until
      // the next change.
    });
    // Run only on first mount of the owner's form. Subsequent draft
    // changes are pushed via setField below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setField(field, value) {
    if (readOnly) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    postJson(`/api/games/${gameId}/configure/update`, {
      playerId,
      draft: next,
    }).catch(() => {
      // Silent — owner's local state is authoritative for commit.
    });
  }

  function ensureCountdown(modeStr, inputStr) {
    if (modeStr !== "down") return 0;
    const s = parseTime(inputStr);
    if (!s) {
      onError("Countdown must be M:SS or MM:SS (e.g. 5:00)");
      return null;
    }
    return s;
  }

  async function commit(extra = {}) {
    onError("");
    const body = { playerId, mode: draft.mode, ...extra };
    if (draft.mode === "compete") {
      if (draft.endModeCompete === "down") {
        const cs = ensureCountdown("down", draft.countdownInputCompete);
        if (cs === null) return;
        body.timerMode = "down";
        body.countdownSeconds = cs;
      } else {
        body.timerMode = "up";
        body.targetRank = draft.targetRankCompete;
      }
    } else {
      const cs = ensureCountdown(draft.timerMode, draft.countdownInput);
      if (cs === null) return;
      body.timerMode = draft.timerMode;
      body.countdownSeconds = cs;
    }
    setSubmitting(true);
    try {
      // Server pushes "active" state via WS; lobby's effect navigates.
      await postJson(`/api/games/${gameId}/configure/commit`, body);
    } catch (e) {
      onError(e.message);
      setSubmitting(false);
    }
  }

  function commitRandom() {
    return commit();
  }

  function commitCustom(evt) {
    evt.preventDefault();
    return commit({
      letters: draft.outerInput.toLowerCase(),
      center: draft.centerInput.toLowerCase(),
    });
  }

  return (
    <>
      <div className="App-tabs" role="tablist" aria-label="Game mode">
        <button
          type="button"
          role="tab"
          aria-selected={draft.mode === "multi"}
          tabIndex={draft.mode === "multi" ? 0 : -1}
          className={`App-tab${draft.mode === "multi" ? " is-active" : ""}`}
          onClick={() => setField("mode", "multi")}
          disabled={readOnly}
        >
          Co-op
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={draft.mode === "compete"}
          tabIndex={draft.mode === "compete" ? 0 : -1}
          className={`App-tab${draft.mode === "compete" ? " is-active" : ""}`}
          onClick={() => setField("mode", "compete")}
          disabled={readOnly}
        >
          Compete
        </button>
      </div>

      {draft.mode === "multi" ? (
        <TimerControls
          radioGroup="cfg-timer"
          mode={draft.timerMode}
          onModeChange={(v) => setField("timerMode", v)}
          countdown={draft.countdownInput}
          onCountdownChange={(v) => setField("countdownInput", v)}
          disabled={readOnly}
        />
      ) : (
        <EndCondition
          radioGroup="cfg-end"
          mode={draft.endModeCompete}
          onModeChange={(v) => setField("endModeCompete", v)}
          countdown={draft.countdownInputCompete}
          onCountdownChange={(v) => setField("countdownInputCompete", v)}
          targetRank={draft.targetRankCompete}
          onTargetRankChange={(v) => setField("targetRankCompete", v)}
          disabled={readOnly}
        />
      )}

      {!readOnly && (
        <div className="App-start-row">
          <span className="App-start-row-label">Random letters</span>
          <button
            type="button"
            className="App-start-go"
            onClick={commitRandom}
            disabled={busy || submitting}
            aria-label="Start with random letters"
          >
            Go
          </button>
        </div>
      )}
      <CustomLettersForm
        center={draft.centerInput}
        onCenterChange={(v) => setField("centerInput", v)}
        outer={draft.outerInput}
        onOuterChange={(v) => setField("outerInput", v)}
        onSubmit={commitCustom}
        disabled={readOnly || busy || submitting}
        ariaLabel="Start with chosen letters"
      />

      {!readOnly && (
        <button
          type="button"
          className="App-start-go"
          onClick={onCancel}
          disabled={busy || submitting}
          style={{ alignSelf: "flex-start" }}
        >
          Cancel
        </button>
      )}
    </>
  );
}
