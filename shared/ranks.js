// Shared by RankBar.jsx (display) and the server's first-to-rank end
// check (compete mode). Don't duplicate these constants — both sides
// need to agree on what counts as Genius.

export const RANKS = [
  "Start",
  "Good",
  "Solid",
  "Nice",
  "Great",
  "Amazing",
  "Genius",
];

// Score-fraction at which "Genius" is reached. Other ranks are spaced
// linearly between 0 and this value.
export const GENIUS_AT = 0.65;

export function rankThreshold(i) {
  return (i / (RANKS.length - 1)) * GENIUS_AT;
}

export function rankPoints(i, total) {
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
