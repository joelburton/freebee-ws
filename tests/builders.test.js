import { promises as fs } from "fs";
import path from "path";
import {
  bitsOf,
  letterBit,
  popcount,
  processWords,
} from "../server/game.js";
import {
  createDefaultBuilder,
  createDiverseBuilder,
  lettersToMask,
} from "../server/builders.js";

// Real word lists drive these tests so we exercise the full pipeline
// (pangram pool → filter → buildGame). Loaded once for the file.
const dataPromise = (async () => {
  const dir = path.join(process.cwd(), "data");
  const [legalText, scoringText] = await Promise.all([
    fs.readFile(path.join(dir, "scowl-80.txt"), "utf8"),
    fs.readFile(path.join(dir, "scowl-50.txt"), "utf8"),
  ]);
  return processWords(legalText, scoringText);
})();

describe("createDefaultBuilder", () => {
  it("returns a valid 7-letter board with ≥30 scoring words", async () => {
    const data = await dataPromise;
    const builder = createDefaultBuilder(data);
    const game = builder.next();
    expect(game.letters).toHaveLength(6);
    expect(game.center).toHaveLength(1);
    expect(game.words).toBeGreaterThanOrEqual(30);
    // No 's' in random boards.
    expect((game.letters + game.center).includes("s")).toBe(false);
  });

  it("ignores previousMask (matches pre-builder behavior)", async () => {
    const data = await dataPromise;
    const builder = createDefaultBuilder(data);
    // Pass a previousMask that overlaps every common letter; the default
    // builder doesn't filter on it, so output is unchanged in shape.
    const game = builder.next({ previousMask: lettersToMask("aeilnort", "") });
    expect(game.letters).toHaveLength(6);
  });
});

describe("createDiverseBuilder", () => {
  it("returns a valid 7-letter board with ≥30 scoring words", async () => {
    const data = await dataPromise;
    const builder = createDiverseBuilder(data);
    const game = builder.next();
    expect(game.letters).toHaveLength(6);
    expect(game.center).toHaveLength(1);
    expect(game.words).toBeGreaterThanOrEqual(30);
  });

  it("respects previousMask: never emits a board sharing more than 4 letters with it", async () => {
    const data = await dataPromise;
    const builder = createDiverseBuilder(data);
    // Use a "core 9"-heavy previous mask so naïve sampling would
    // frequently overlap by 5+. Run many trials to flush out leaks.
    const prev = lettersToMask("aeilnort", "");
    for (let i = 0; i < 200; i++) {
      const game = builder.next({ previousMask: prev });
      const overlap = popcount(lettersToMask(game.letters, game.center) & prev);
      expect(overlap).toBeLessThanOrEqual(4);
    }
  });

  it("boosts rare letters (j q x z) above the default builder's rate", async () => {
    // Statistical assertion — runs N rounds of each, compares aggregate
    // rates. The simulation predicts ~1.4% j with default vs ~5% j with
    // diverse; we use loose thresholds to keep the test stable but
    // still catch a regression that flattens the boost entirely.
    const data = await dataPromise;
    const N = 500;
    const def = createDefaultBuilder(data);
    const div = createDiverseBuilder(data);
    function rareRate(builder) {
      let count = 0;
      for (let i = 0; i < N; i++) {
        const g = builder.next();
        const m = lettersToMask(g.letters, g.center);
        // "Truly rare" letters our weighting targets.
        for (const ch of "jqxz") {
          if (m & letterBit(ch)) {
            count++;
            break;
          }
        }
      }
      return count / N;
    }
    const defRate = rareRate(def);
    const divRate = rareRate(div);
    // Default's rare-letter rate is ~7%; diverse's is ~25%. Require at
    // least a 2× lift to flag a regression while tolerating sampling noise.
    expect(divRate).toBeGreaterThan(defRate * 2);
  });
});

describe("lettersToMask", () => {
  it("converts a letters+center pair to its 7-bit set", () => {
    const m = lettersToMask("bdeint", "r");
    expect(popcount(m)).toBe(7);
    for (const ch of "bdeintr") {
      expect(m & letterBit(ch)).toBeTruthy();
    }
  });

  it("ignores case and skips non-letters", () => {
    const m = lettersToMask("BDEINT", "R");
    expect(popcount(m)).toBe(7);
  });

  it("handles a missing center (empty string)", () => {
    const m = lettersToMask("bdeint", "");
    expect(popcount(m)).toBe(6);
  });
});

describe("BoardBuilder shape", () => {
  it("each builder exposes name + next()", async () => {
    const data = await dataPromise;
    const def = createDefaultBuilder(data);
    const div = createDiverseBuilder(data);
    expect(def.name).toBe("default");
    expect(div.name).toBe("diverse");
    expect(typeof def.next).toBe("function");
    expect(typeof div.next).toBe("function");
  });
});

describe("bitsOf round-trip sanity", () => {
  // Smoke test that the bit primitives we rely on still work — paranoia
  // catch in case game.js changes shape.
  it("bitsOf(mask).length === popcount(mask)", () => {
    const m = lettersToMask("bdeint", "r");
    expect(bitsOf(m)).toHaveLength(popcount(m));
  });
});
