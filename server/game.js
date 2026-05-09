export const MIN_FOUND = 30;
export const MIN_VOWELS = 2;

export function scoreWord(w) {
  const base = w.length === 4 ? 1 : w.length;
  const bonus = new Set(w).size === 7 ? 10 : 0;
  return base + bonus;
}

export function scoreFor(words) {
  let total = 0;
  for (const w of words) total += scoreWord(w);
  return total;
}

// Single-bit mask for letter `c` ('a'→bit 0, 'z'→bit 25). Inputs assumed lowercase a–z.
export function letterBit(c) {
  return 1 << (c.charCodeAt(0) - 97);
}

export const S_BIT = letterBit("s");
export const Q_BIT = letterBit("q");
export const U_BIT = letterBit("u");
export const VOWEL_BITS = ["a", "e", "i", "o", "u"].reduce(
  (m, c) => m | letterBit(c),
  0,
);

// Boards containing all of i, n, g feel repetitive in practice (~20% of
// natural pangram-set draws have all three; "-ing" enables many easy
// finds). We accept them with this probability, dropping their effective
// rate to ~7%.
export const ING_BITS = letterBit("i") | letterBit("n") | letterBit("g");
export const ING_ACCEPT_RATE = 1 / 3;

// Number of 1-bits in n (Kernighan loop).
export function popcount(n) {
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

// Inverse of letterBit: a single-bit mask back to its 'a'–'z' character ('' if none).
export function bitToLetter(bit) {
  for (let i = 0; i < 26; i++) {
    if (bit === 1 << i) return String.fromCharCode(97 + i);
  }
  return "";
}

// Splits a multi-bit mask into an array of its individual single-bit values.
export function bitsOf(mask) {
  const out = [];
  let m = mask;
  while (m) {
    const lo = m & -m;
    out.push(lo);
    m &= m - 1;
  }
  return out;
}

// Returns a new Fisher–Yates shuffled copy of `arr` (does not mutate input).
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Encodes the puzzle rules from CLAUDE.md: no 's', q→u, ≥2 vowels (y excluded).
export function isValidPuzzleMask(mask) {
  if (mask & S_BIT) return false;
  if (mask & Q_BIT && !(mask & U_BIT)) return false;
  if (popcount(mask & VOWEL_BITS) < MIN_VOWELS) return false;
  return true;
}

// Preprocesses both word lists into parallel arrays of (word, mask, length,
// inScoring) plus the set of pangram-eligible letter masks. `legalText` is the
// full set of accepted words (larger SCOWL size); `scoringText` is the subset
// that drives the rank/score/reveal display (smaller SCOWL, ⊆ legalText).
export function processWords(legalText, scoringText = "") {
  const scoringSet = new Set();
  for (const raw of scoringText.split("\n")) {
    const w = raw.trim();
    if (w) scoringSet.add(w);
  }

  const words = [];
  const masks = [];
  const lengths = [];
  const inScoring = [];
  const pangramMaskSet = new Set();

  for (const raw of legalText.split("\n")) {
    const w = raw.trim();
    if (w.length < 4) continue;

    let mask = 0;
    let ok = true;
    for (let i = 0; i < w.length; i++) {
      const code = w.charCodeAt(i) - 97;
      if (code < 0 || code > 25) {
        ok = false;
        break;
      }
      mask |= 1 << code;
    }
    if (!ok) continue;
    const distinct = popcount(mask);
    if (distinct > 7) continue;
    // 's' words stay in the word list so custom boards can use them; the
    // no-'s' rule is enforced via isValidPuzzleMask on pangram candidates,
    // which keeps random puzzles 's'-free.

    words.push(w);
    masks.push(mask);
    lengths.push(w.length);
    const inScore = scoringSet.has(w);
    inScoring.push(inScore);

    // Only count pangrams from the scoring list — guarantees the puzzle's
    // "official" answer set has a pangram.
    if (distinct === 7 && isValidPuzzleMask(mask) && inScore) {
      pangramMaskSet.add(mask);
    }
  }

  return {
    words,
    masks,
    lengths,
    inScoring,
    pangramMasks: [...pangramMaskSet],
  };
}

// Builds a game payload for a chosen 7-letter set + center. Used by the
// custom-letters path and by every BoardBuilder once they've decided on
// a (allowedMask, centerBit) pair.
export function buildGame(data, allowedMask, centerBit) {
  const { words, masks, inScoring } = data;
  const wordlist = [];
  const revealList = [];
  let total = 0;

  for (let i = 0; i < masks.length; i++) {
    const m = masks[i];
    if ((m & allowedMask) !== m) continue;
    if ((m & centerBit) === 0) continue;

    wordlist.push(words[i]);

    if (inScoring[i]) {
      revealList.push(words[i]);
      total += scoreWord(words[i]);
    }
  }

  const center = bitToLetter(centerBit);
  const outerBits = bitsOf(allowedMask & ~centerBit);
  const outers = shuffle(outerBits.map(bitToLetter));
  return {
    letters: outers.join(""),
    center,
    words: revealList.length,
    total,
    wordlist,
    revealList,
  };
}

// Picks random pangram-letter-sets until one yields ≥MIN_FOUND scoring words.
// Pangram-only candidates guarantee at least one pangram exists in every puzzle.
// ING-bearing masks are dampened (see ING_ACCEPT_RATE) — they're common
// in the natural distribution and feel repetitive across sessions.
export function makeGame(data) {
  const { pangramMasks } = data;
  while (true) {
    const allowedMask =
      pangramMasks[Math.floor(Math.random() * pangramMasks.length)];
    if (
      (allowedMask & ING_BITS) === ING_BITS &&
      Math.random() >= ING_ACCEPT_RATE
    ) {
      continue;
    }
    const bits = bitsOf(allowedMask);
    const centerBit = bits[Math.floor(Math.random() * bits.length)];
    const game = buildGame(data, allowedMask, centerBit);
    if (game.words >= MIN_FOUND) return game;
  }
}

// Returns null if valid; otherwise an error string. Custom puzzles bypass
// the puzzle-rule checks (no-s, q→u, ≥2 vowels) — only structural input
// validation applies. Picking off-rule letters may yield very few words.
export function validateCustomLetters(outerStr, centerStr) {
  const center = (centerStr || "").toLowerCase().trim();
  const outers = (outerStr || "").toLowerCase().trim();
  if (center.length !== 1) return "Center must be exactly 1 letter";
  if (!/^[a-z]$/.test(center)) return "Center must be a letter (a–z)";
  if (outers.length !== 6) return "Need exactly 6 outer letters";
  if (!/^[a-z]+$/.test(outers)) return "Outer letters must be a–z";
  if (new Set(outers + center).size !== 7) {
    return "All 7 letters must be distinct";
  }
  return null;
}

export function makeCustomGame(data, outerStr, centerStr) {
  const center = centerStr.toLowerCase();
  const outers = outerStr.toLowerCase();
  const allowedMask = [...(outers + center)].reduce(
    (m, c) => m | letterBit(c),
    0,
  );
  const centerBit = letterBit(center);
  return buildGame(data, allowedMask, centerBit);
}
