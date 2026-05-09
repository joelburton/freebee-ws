// Compete-mode side-bar pieces: leaderboard rows, the post-end winner
// banner, and the small "leave the group" affordance shared by both
// the leaderboard and the co-op roster.

// Compete leaderboard — sorted by score desc, with each player's name,
// score and word count. Post-end, each top-scoring player is tagged
// "winner" — or "tied" when the top score is shared. The current
// player gets a small × to leave the group instead of a "you" pill.
export function Leaderboard({ players, playerId, winnerId, ended, onLeave }) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const topScore = sorted.length ? sorted[0].score : 0;
  const sharedTop =
    ended && sorted.filter((p) => p.score === topScore).length > 1;
  return (
    <ol className="Game-leaderboard" aria-label="Leaderboard">
      {sorted.map((p) => {
        const atTop = ended && p.score === topScore && topScore > 0;
        return (
          <li
            key={p.playerId}
            className={`Game-leaderboard-row${
              p.online === false ? " is-offline" : ""
            }${p.playerId === winnerId && !sharedTop ? " is-winner" : ""}`}
            style={{ "--player-color": p.color }}
          >
            <span className="Game-roster-dot" aria-hidden="true" />
            <span className="Game-leaderboard-id">
              <span className="Game-leaderboard-name">{p.name}</span>
              {p.playerId === playerId && onLeave && (
                <LeaveX onClick={onLeave} />
              )}
            </span>
            {atTop && sharedTop && (
              <span className="Game-roster-tag Game-roster-tag-tied">
                tied
              </span>
            )}
            {atTop && !sharedTop && (
              <span className="Game-roster-tag Game-roster-tag-winner">
                winner
              </span>
            )}
            <span className="Game-leaderboard-score">{p.score}</span>
            <span className="Game-leaderboard-count">/ {p.foundCount}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Tiny "leave the group" affordance shown next to the current player's
// row in rosters and leaderboards. Replaces both the standalone "Leave"
// button (which read as a generic action when sat next to End game)
// and the redundant "you" pill (the × is itself a self-locator).
export function LeaveX({ onClick }) {
  return (
    <button
      type="button"
      className="Roster-leave"
      onClick={onClick}
      title="Leave group"
      aria-label="Leave group"
    >
      ×
    </button>
  );
}

export function WinnerBanner({ players, winnerId }) {
  const winner = players.find((p) => p.playerId === winnerId);
  if (!winner) return null;
  return (
    <div className="Game-winner" role="status" aria-live="polite">
      <span className="Game-winner-name" style={{ color: winner.color }}>
        {winner.name}
      </span>{" "}
      wins!
    </div>
  );
}
