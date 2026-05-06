import { RANKS, rankPoints, currentRankIndex } from "../../shared/ranks";

export { currentRankIndex };

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
