const RANKS = ["Start", "Good", "Solid", "Nice", "Great", "Amazing", "Genius"];
const GENIUS_AT = 0.65;

function rankThreshold(i) {
  return (i / (RANKS.length - 1)) * GENIUS_AT;
}

function rankPoints(i, total) {
  return Math.ceil(rankThreshold(i) * total);
}

export function currentRankIndex(score, total) {
  if (!total) return 0;
  const ratio = score / total;
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (ratio >= rankThreshold(i)) idx = i;
  }
  return idx;
}

export default function RankBar({ score, total }) {
  const idx = currentRankIndex(score, total);
  return (
    <div className="RankBar">
      <span className="RankBar-label">{RANKS[idx]}</span>
      <ol className="RankBar-track">
        {RANKS.map((name, i) => {
          const pts = rankPoints(i, total);
          return (
            <li
              key={name}
              className={
                i <= idx ? "Rank-dot Rank-dot-achieved" : "Rank-dot"
              }
              aria-label={`${name}, ${pts} points`}
            >
              <span className="Rank-tooltip">
                {name} · {pts} pts
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
