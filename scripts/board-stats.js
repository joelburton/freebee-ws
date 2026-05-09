// Research: how biased are our randomly-generated boards?
//
// Generates N boards via the same makeGame() the server uses and
// reports per-letter frequency, most-common letter sets, vowel
// distribution, the "natural pool" vs the post-filter distribution,
// and how often the MIN_FOUND/ING-dampening filters reject draws.
//
// Run: node scripts/board-stats.js [N]
import fs from "node:fs/promises";
import path from "node:path";
import {
  ING_ACCEPT_RATE,
  ING_BITS,
  MIN_FOUND,
  bitsOf,
  bitToLetter,
  letterBit,
  popcount,
  processWords,
} from "../server/game.js";

const N = parseInt(process.argv[2] ?? "10000", 10);

const dir = path.join(process.cwd(), "data");
const [legalText, scoringText] = await Promise.all([
  fs.readFile(path.join(dir, "scowl-80.txt"), "utf8"),
  fs.readFile(path.join(dir, "scowl-50.txt"), "utf8"),
]);
const data = processWords(legalText, scoringText);

console.log(`Loaded: ${data.words.length} legal words, ${data.pangramMasks.length} unique pangram-letter-sets`);

// ---- Distributions of the underlying pools ------------------------------

// All valid 7-letter masks that contain ≥1 pangram (the universe makeGame
// samples from). It's already filtered for is-valid + scoring-list pangram.
const POOL = data.pangramMasks;

// Per-letter frequency in the pool (no MIN_FOUND filter, no ING dampening).
function letterFreq(masks) {
  const counts = new Array(26).fill(0);
  for (const m of masks) {
    for (let i = 0; i < 26; i++) {
      if (m & (1 << i)) counts[i]++;
    }
  }
  return counts;
}
function asPct(counts, total) {
  return counts.map((c) => (100 * c) / total);
}
const poolPct = asPct(letterFreq(POOL), POOL.length);

// ---- Generate N boards and instrument the loop --------------------------
//
// We replicate makeGame's loop here so we can count rejections (MIN_FOUND
// fails, ING-dampening drops) on the way.
function buildGameLite(data, allowedMask, centerBit) {
  // Same logic as buildGame but only returns the count we need (faster).
  const { masks, inScoring } = data;
  let words = 0;
  for (let i = 0; i < masks.length; i++) {
    const m = masks[i];
    if ((m & allowedMask) !== m) continue;
    if ((m & centerBit) === 0) continue;
    if (inScoring[i]) words++;
  }
  return words;
}

let drawsTotal = 0;
let ingDamped = 0;
let minFoundFails = 0;
const acceptedMasks = [];
const acceptedCenters = [];

for (let i = 0; i < N; i++) {
  while (true) {
    drawsTotal++;
    const allowedMask = POOL[Math.floor(Math.random() * POOL.length)];
    if (
      (allowedMask & ING_BITS) === ING_BITS &&
      Math.random() >= ING_ACCEPT_RATE
    ) {
      ingDamped++;
      continue;
    }
    const bits = bitsOf(allowedMask);
    const centerBit = bits[Math.floor(Math.random() * bits.length)];
    const wordsForCenter = buildGameLite(data, allowedMask, centerBit);
    if (wordsForCenter < MIN_FOUND) {
      minFoundFails++;
      continue;
    }
    acceptedMasks.push(allowedMask);
    acceptedCenters.push(centerBit);
    break;
  }
}

const generatedPct = asPct(letterFreq(acceptedMasks), N);

// Center-letter distribution (which letter ends up as the required center).
const centerCounts = new Array(26).fill(0);
for (const c of acceptedCenters) {
  for (let i = 0; i < 26; i++) {
    if (c & (1 << i)) centerCounts[i]++;
  }
}
const centerPct = centerCounts.map((c) => (100 * c) / N);

// ---- Reporting ----------------------------------------------------------

function letter(i) {
  return String.fromCharCode(97 + i);
}

console.log(`\n--- Generated ${N} boards ---`);
console.log(`Draws made: ${drawsTotal} (acceptance rate ${(N / drawsTotal * 100).toFixed(1)}%)`);
console.log(`  ING-dampened rejections: ${ingDamped} (${(100 * ingDamped / drawsTotal).toFixed(1)}%)`);
console.log(`  MIN_FOUND<${MIN_FOUND} rejections: ${minFoundFails} (${(100 * minFoundFails / drawsTotal).toFixed(1)}%)`);

// Per-letter frequency in generated boards vs pool vs uniform
console.log(`\n--- Letter frequency: % of boards each letter appears in ---`);
console.log(`  uniform = 7/25 = 28.0% (random pick of 7 from 25 valid letters)`);
console.log(`  pool    = % across the ${POOL.length} pangram-eligible masks`);
console.log(`  gen     = % across the ${N} generated boards`);
console.log(`  center  = % chance this letter is the required center`);
console.log(`  Δ       = gen − pool (positive = our filter prefers it)`);
console.log("");
const rows = [];
for (let i = 0; i < 26; i++) {
  if (letter(i) === "s") continue; // never in random boards
  rows.push({
    letter: letter(i),
    pool: poolPct[i],
    gen: generatedPct[i],
    center: centerPct[i],
    delta: generatedPct[i] - poolPct[i],
  });
}
rows.sort((a, b) => b.gen - a.gen);
console.log(
  ["letter", "pool%", "gen%", "center%", "Δ"].map((s) => s.padStart(7)).join("  "),
);
for (const r of rows) {
  console.log(
    [
      r.letter,
      r.pool.toFixed(1),
      r.gen.toFixed(1),
      r.center.toFixed(1),
      (r.delta >= 0 ? "+" : "") + r.delta.toFixed(1),
    ]
      .map((s) => s.padStart(7))
      .join("  "),
  );
}

// Most common letter sets
console.log(`\n--- Top 20 most-common 7-letter sets in generated boards ---`);
const setCounts = new Map();
for (const m of acceptedMasks) {
  setCounts.set(m, (setCounts.get(m) || 0) + 1);
}
const topSets = [...setCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);
for (const [m, count] of topSets) {
  const letters = bitsOf(m).map(bitToLetter).sort().join("");
  console.log(`  ${letters.padEnd(7)}  ${count}  (${(100 * count / N).toFixed(2)}%)`);
}

// Vowel-count distribution
console.log(`\n--- Vowel count distribution (of A E I O U; y excluded) ---`);
const vowelMask = ["a", "e", "i", "o", "u"].reduce(
  (m, c) => m | letterBit(c),
  0,
);
const vowelHist = new Array(8).fill(0);
for (const m of acceptedMasks) {
  vowelHist[popcount(m & vowelMask)]++;
}
for (let v = 0; v <= 5; v++) {
  if (vowelHist[v] === 0) continue;
  const pct = (100 * vowelHist[v]) / N;
  console.log(`  ${v} vowels: ${vowelHist[v]} (${pct.toFixed(1)}%)`);
}

// Common pairs / triples — co-occurrence biases beyond just per-letter
console.log(`\n--- Top 15 letter PAIRS by co-occurrence rate ---`);
const pairCounts = new Map();
for (const m of acceptedMasks) {
  const bits = bitsOf(m);
  for (let i = 0; i < bits.length; i++) {
    for (let j = i + 1; j < bits.length; j++) {
      const key = bitToLetter(bits[i]) + bitToLetter(bits[j]);
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }
}
// Compare each pair's actual rate to its expected rate under independence
// (P(A in board) × P(B in board) gives a rough baseline).
const pairExpected = (a, b) =>
  (generatedPct[a.charCodeAt(0) - 97] / 100) *
  (generatedPct[b.charCodeAt(0) - 97] / 100);
const pairsRanked = [...pairCounts.entries()]
  .map(([k, c]) => ({
    pair: k,
    rate: c / N,
    expected: pairExpected(k[0], k[1]),
  }))
  .map((p) => ({ ...p, lift: p.rate / p.expected }))
  .sort((a, b) => b.rate - a.rate);
console.log(`  pair   actual%   expected%   lift  (lift > 1 = correlated)`);
for (const p of pairsRanked.slice(0, 15)) {
  console.log(
    `  ${p.pair}   ${(p.rate * 100).toFixed(1).padStart(5)}     ${(p.expected * 100).toFixed(1).padStart(5)}    ${p.lift.toFixed(2)}`,
  );
}

// Triples — most common 3-letter co-occurrences
console.log(`\n--- Top 15 letter TRIPLES by co-occurrence rate ---`);
const tripleCounts = new Map();
for (const m of acceptedMasks) {
  const bits = bitsOf(m);
  for (let i = 0; i < bits.length; i++) {
    for (let j = i + 1; j < bits.length; j++) {
      for (let k = j + 1; k < bits.length; k++) {
        const key =
          bitToLetter(bits[i]) +
          bitToLetter(bits[j]) +
          bitToLetter(bits[k]);
        tripleCounts.set(key, (tripleCounts.get(key) || 0) + 1);
      }
    }
  }
}
const triplesRanked = [...tripleCounts.entries()]
  .map(([k, c]) => ({ triple: k, rate: c / N }))
  .sort((a, b) => b.rate - a.rate);
console.log(`  triple   rate%`);
for (const t of triplesRanked.slice(0, 15)) {
  console.log(`  ${t.triple}     ${(t.rate * 100).toFixed(1)}`);
}

// "Bottom of the deck" — letters that appear least often
console.log(`\n--- 5 rarest letters in generated boards ---`);
const rare = [...rows].sort((a, b) => a.gen - b.gen).slice(0, 5);
for (const r of rare) {
  console.log(`  ${r.letter}: ${r.gen.toFixed(1)}% of boards (pool: ${r.pool.toFixed(1)}%)`);
}

// Skew: ratio of top-7 vs bottom-7 letter frequencies
const sorted = [...rows].sort((a, b) => b.gen - a.gen);
const topSeven = sorted.slice(0, 7).reduce((s, r) => s + r.gen, 0) / 7;
const bottomSeven = sorted.slice(-7).reduce((s, r) => s + r.gen, 0) / 7;
console.log(`\n--- Skew ---`);
console.log(`  Avg appearance rate of top-7 letters:    ${topSeven.toFixed(1)}%`);
console.log(`  Avg appearance rate of bottom-7 letters: ${bottomSeven.toFixed(1)}%`);
console.log(`  Ratio: ${(topSeven / bottomSeven).toFixed(2)}× (uniform = 1.00)`);

// Diversity of letter sets: Gini-ish coefficient based on how concentrated
// the boards are in a small number of distinct masks.
console.log(`\n--- Letter-set diversity ---`);
const totalDistinctSets = setCounts.size;
const top10Share = topSets
  .slice(0, 10)
  .reduce((s, [, c]) => s + c, 0) / N;
const top20Share = topSets.reduce((s, [, c]) => s + c, 0) / N;
console.log(`  Distinct letter sets used: ${totalDistinctSets} (out of ${POOL.length} possible, ${(100 * totalDistinctSets / POOL.length).toFixed(1)}%)`);
console.log(`  Top 10 sets account for ${(100 * top10Share).toFixed(1)}% of boards`);
console.log(`  Top 20 sets account for ${(100 * top20Share).toFixed(1)}% of boards`);

// "Core 9" analysis: the dominant letters identified by the per-letter
// frequency report. How many boards lean entirely on these vs include
// some less-common letters?
const CORE9 = "adeilnort"
  .split("")
  .reduce((m, c) => m | letterBit(c), 0);
const interesting = ((1 << 26) - 1) & ~CORE9 & ~letterBit("s");
const coreHist = new Array(8).fill(0);
for (const m of acceptedMasks) {
  coreHist[popcount(m & interesting)]++;
}
console.log(`\n--- 'Interesting'-letter content (non-core, non-s) ---`);
console.log(`  core 9 = a d e i l n o r t — the letters dominant in pangrams`);
for (let k = 0; k <= 7; k++) {
  if (coreHist[k] === 0) continue;
  const pct = (100 * coreHist[k]) / N;
  const bar = "█".repeat(Math.round(pct / 2));
  console.log(
    `  ${k} interesting letters: ${String(coreHist[k]).padStart(5)} (${pct.toFixed(1)}%) ${bar}`,
  );
}
