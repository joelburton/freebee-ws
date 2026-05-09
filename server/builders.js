// Board-generation strategies, behind a uniform interface so the rest
// of the server doesn't care which one's active. New strategies (e.g.
// "min N pangrams", "min N words", custom diversity rules) plug in by
// adding another factory below and a key in the BUILDERS registry.
//
// Builder shape (every factory returns this):
//
//   {
//     name: string,
//     next({ previousMask?: number }): {
//       letters, center, words, total, wordlist, revealList
//     }
//   }
//
// `previousMask` is the 7-bit set of the immediately preceding board
// in the same context (group, or solo session). Strategies are free
// to ignore it. `next()` is synchronous; any expensive prep (weighted
// pools, etc.) is amortized at construction.

import {
  ING_ACCEPT_RATE,
  ING_BITS,
  MIN_FOUND,
  bitsOf,
  buildGame,
  letterBit,
  popcount,
} from "./game.js";

// --- Default builder: the original makeGame algorithm ------------------
//
// Pick a uniformly random pangram mask, dampen ING-bearing draws, accept
// when we land on a (mask, center) pair that yields ≥ MIN_FOUND words.
// Ignores previousMask; no per-letter weighting.

export function createDefaultBuilder(data) {
  const { pangramMasks } = data;
  return {
    name: "default",
    next() {
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
    },
  };
}

// --- Diverse builder: tier-weighted pool + previous-board overlap cap ---
//
// Two compounding levers, both calibrated against simulation data:
//
//   1. The candidate pool repeats rare-letter pangrams more often. The
//      natural English distribution puts j/q/x/z in only ~2-3% of valid
//      pangrams; uniform sampling reproduces that, so players see ~1%
//      'j' boards. Repeating those pangrams in the array boosts their
//      pick rate without changing the arithmetic of sampling.
//
//   2. Each board must differ from the previous one (in the same group
//      / solo context) by at least 3 letters. This cuts the average
//      consecutive overlap from 3.10 → 2.78 of 7, which is the main
//      driver of the "we keep finding the same words" feeling within a
//      session.
//
// Together the cost is roughly +28% draws per board (1.49 → 1.91) —
// still microseconds. See scripts/board-stats.js for the simulation.

// Per-tier weight multiplier. Pangrams containing letters from each
// tier compound: a pangram with a 'j' AND a 'k' gets weight 8 × 3 = 24.
function lettersToBits(s) {
  return s.split("").reduce((acc, c) => acc | letterBit(c), 0);
}
const TIER_WEIGHTS = [
  { bits: lettersToBits("jqxz"), weight: 8 },
  { bits: lettersToBits("kvwy"), weight: 3 },
  { bits: lettersToBits("bfh"), weight: 1.5 },
];

// Boards may share at most this many letters with the immediately
// previous board (out of 7). 4 leaves room for natural English overlap
// while breaking up "this board feels like the last one" runs.
const MAX_PREV_OVERLAP = 4;

function tierWeight(mask) {
  let w = 1;
  for (const { bits, weight } of TIER_WEIGHTS) {
    if (mask & bits) w *= weight;
  }
  return w;
}

function buildWeightedPool(pangramMasks) {
  const out = [];
  for (const m of pangramMasks) {
    const copies = Math.max(1, Math.round(tierWeight(m)));
    for (let i = 0; i < copies; i++) out.push(m);
  }
  return out;
}

export function createDiverseBuilder(data) {
  const weightedPool = buildWeightedPool(data.pangramMasks);
  return {
    name: "diverse",
    next({ previousMask = null } = {}) {
      while (true) {
        const allowedMask =
          weightedPool[Math.floor(Math.random() * weightedPool.length)];
        if (
          (allowedMask & ING_BITS) === ING_BITS &&
          Math.random() >= ING_ACCEPT_RATE
        ) {
          continue;
        }
        if (
          previousMask !== null &&
          popcount(allowedMask & previousMask) > MAX_PREV_OVERLAP
        ) {
          continue;
        }
        const bits = bitsOf(allowedMask);
        const centerBit = bits[Math.floor(Math.random() * bits.length)];
        const game = buildGame(data, allowedMask, centerBit);
        if (game.words >= MIN_FOUND) return game;
      }
    },
  };
}

// --- Registry ---------------------------------------------------------
//
// Future per-game configuration would pick a builder by name from here.
// For now `ACTIVE` is the global default; tests and `_resetActiveBuilder`
// can override it.

export const BUILDERS = {
  default: createDefaultBuilder,
  diverse: createDiverseBuilder,
};

const ACTIVE = "diverse";

let _builder = null;
let _builderName = null;

export function getActiveBuilder(data) {
  if (_builder && _builderName === ACTIVE) return _builder;
  const factory = BUILDERS[ACTIVE];
  if (!factory) throw new Error(`Unknown builder: ${ACTIVE}`);
  _builder = factory(data);
  _builderName = ACTIVE;
  return _builder;
}

// Test hook: forget the cached builder so the next getActiveBuilder()
// rebuilds. Useful if a test wants to run with a custom data set.
export function _resetActiveBuilder() {
  _builder = null;
  _builderName = null;
}

// --- Helpers ----------------------------------------------------------

// Convert a "letters" string + "center" string (as stored on a session)
// to the 7-bit mask used by builders.
export function lettersToMask(letters, center) {
  let m = 0;
  for (const c of (letters + center).toLowerCase()) {
    if (c >= "a" && c <= "z") m |= letterBit(c);
  }
  return m;
}
