import { promises as fs } from "fs";
import path from "path";
import {
  popcount,
  letterBit,
  bitToLetter,
  bitsOf,
  shuffle,
  isValidPuzzleMask,
  processWords,
  makeGame,
  makeCustomGame,
  validateCustomLetters,
  scoreWord,
  scoreFor,
  MIN_FOUND,
} from "../server/game.js";
import {
  LEGAL_WORDS_FILE,
  SCORING_WORDS_FILE,
} from "../server/sessions.js";

function maskOf(s) {
  return s.split("").reduce((m, c) => m | letterBit(c), 0);
}

describe("scoreWord", () => {
  it("scores 4-letter words as 1", () => {
    expect(scoreWord("four")).toBe(1);
  });
  it("scores 5+ letter words as their length", () => {
    expect(scoreWord("tribe")).toBe(5);
    expect(scoreWord("trident")).toBe(7);
  });
  it("adds +10 for pangrams (7 distinct letters)", () => {
    expect(scoreWord("interbred")).toBe(9 + 10);
  });
  it("does not add the pangram bonus to a 7-letter non-pangram", () => {
    // 7 letters, only 4 distinct
    expect(scoreWord("teeteer")).toBe(7);
  });
});

describe("scoreFor", () => {
  it("returns 0 for an empty array", () => {
    expect(scoreFor([])).toBe(0);
  });
  it("sums scoreWord across the array", () => {
    expect(scoreFor(["four", "tribe", "interbred"])).toBe(1 + 5 + 19);
  });
});

describe("popcount", () => {
  it("returns 0 for 0", () => {
    expect(popcount(0)).toBe(0);
  });
  it("counts bits", () => {
    expect(popcount(0b1)).toBe(1);
    expect(popcount(0b101)).toBe(2);
    expect(popcount(0b1111111)).toBe(7);
    expect(popcount(0xffffff)).toBe(24);
  });
});

describe("letterBit / bitToLetter", () => {
  it("maps a-z bidirectionally", () => {
    for (let i = 0; i < 26; i++) {
      const ch = String.fromCharCode(97 + i);
      expect(letterBit(ch)).toBe(1 << i);
      expect(bitToLetter(1 << i)).toBe(ch);
    }
  });
});

describe("bitsOf", () => {
  it("decomposes a mask into single-bit values", () => {
    const m = letterBit("a") | letterBit("c") | letterBit("z");
    const bits = bitsOf(m);
    expect(bits).toHaveLength(3);
    expect(bits.reduce((s, b) => s | b, 0)).toBe(m);
    for (const b of bits) expect(popcount(b)).toBe(1);
  });
  it("returns [] for 0", () => {
    expect(bitsOf(0)).toEqual([]);
  });
});

describe("shuffle", () => {
  it("preserves the multiset of elements", () => {
    const arr = [1, 2, 3, 4, 5];
    const out = shuffle(arr);
    expect(out.slice().sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it("does not mutate the input", () => {
    const arr = [1, 2, 3];
    shuffle(arr);
    expect(arr).toEqual([1, 2, 3]);
  });
});

describe("isValidPuzzleMask", () => {
  it("rejects masks containing s", () => {
    expect(isValidPuzzleMask(maskOf("aeiortn") | letterBit("s"))).toBe(false);
  });
  it("rejects q without u", () => {
    expect(isValidPuzzleMask(maskOf("aeiqbcd"))).toBe(false);
  });
  it("accepts q with u", () => {
    expect(isValidPuzzleMask(maskOf("aeiqubc"))).toBe(true);
  });
  it("rejects fewer than 2 vowels", () => {
    expect(isValidPuzzleMask(maskOf("abcdfgh"))).toBe(false);
  });
  it("accepts 2+ vowels with no s and no q-without-u", () => {
    expect(isValidPuzzleMask(maskOf("aebcdfg"))).toBe(true);
  });
});

describe("processWords", () => {
  it("drops words shorter than 4", () => {
    const data = processWords("a\nbe\ntri\nfour", "four");
    expect(data.words).toEqual(["four"]);
  });
  it("keeps words containing 's' so custom boards can use them", () => {
    const data = processWords("rest\ntest\nfour", "four");
    expect(data.words).toEqual(["rest", "test", "four"]);
  });
  it("does not promote 's'-containing pangram-shaped words to pangramMasks", () => {
    // 7-distinct, contains 's' — must not appear in pangramMasks.
    const data = processWords("anglers\nfour", "anglers\nfour");
    expect(data.pangramMasks).toEqual([]);
  });
  it("drops words with non-letter chars", () => {
    const data = processWords("can't\nfour", "four");
    expect(data.words).toEqual(["four"]);
  });
  it("drops words with more than 7 distinct letters", () => {
    const data = processWords("background\nfour", "four");
    expect(data.words).toEqual(["four"]);
  });
  it("computes mask and length for kept words", () => {
    const data = processWords("four\ntime", "four\ntime");
    expect(data.words).toEqual(["four", "time"]);
    expect(data.masks[0]).toBe(maskOf("four"));
    expect(data.masks[1]).toBe(maskOf("time"));
    expect(data.lengths).toEqual([4, 4]);
  });
  it("only treats pangrams as candidates if they're in the scoring list", () => {
    // interbred is in legal text but not in scoring text → no pangram set.
    const data = processWords("interbred\nfour", "four");
    expect(data.pangramMasks).toEqual([]);
  });
  it("collects scoring-list pangram masks satisfying puzzle rules", () => {
    const data = processWords("interbred\nfour", "interbred\nfour");
    expect(data.pangramMasks).toEqual([maskOf("bdeinrt")]);
  });
  it("rejects pangrams with too few vowels", () => {
    const data = processWords("bcdfght\nfour", "bcdfght\nfour");
    expect(data.pangramMasks).toEqual([]);
  });
  it("inScoring marks legal-only words as false", () => {
    const data = processWords("four\ntime", "four");
    expect(data.words).toEqual(["four", "time"]);
    expect(data.inScoring).toEqual([true, false]);
  });
});

describe("makeGame against the real word lists", () => {
  let data;

  beforeAll(async () => {
    const dir = path.join(process.cwd(), "data");
    const [legalText, scoringText] = await Promise.all([
      fs.readFile(path.join(dir, LEGAL_WORDS_FILE), "utf8"),
      fs.readFile(path.join(dir, SCORING_WORDS_FILE), "utf8"),
    ]);
    data = processWords(legalText, scoringText);
  });

  it("returns a puzzle satisfying every invariant, repeatedly", () => {
    for (let i = 0; i < 30; i++) {
      const game = makeGame(data);

      expect(game.letters).toHaveLength(6);
      expect(game.center).toHaveLength(1);
      expect(game.words).toBeGreaterThanOrEqual(MIN_FOUND);
      expect(game.revealList).toHaveLength(game.words);
      expect(game.wordlist.length).toBeGreaterThanOrEqual(
        game.revealList.length,
      );
      expect(game.total).toBeGreaterThan(0);

      const allowed = new Set([...game.letters, game.center]);
      expect(allowed.size).toBe(7);
      expect(allowed.has("s")).toBe(false);
      if (allowed.has("q")) expect(allowed.has("u")).toBe(true);

      const vowels = [...allowed].filter((c) =>
        "aeiou".includes(c),
      ).length;
      expect(vowels).toBeGreaterThanOrEqual(2);

      // every word in either list uses only allowed letters and contains center
      for (const w of game.wordlist) {
        expect(w).toContain(game.center);
        for (const ch of w) expect(allowed.has(ch)).toBe(true);
        expect(w.length).toBeGreaterThanOrEqual(4);
      }

      // revealList ⊆ wordlist
      const wordlistSet = new Set(game.wordlist);
      for (const w of game.revealList) {
        expect(wordlistSet.has(w)).toBe(true);
      }

      // at least one pangram in the *scoring* (reveal) list
      const hasPangram = game.revealList.some(
        (w) => new Set(w).size === 7,
      );
      expect(hasPangram).toBe(true);
    }
  });

  it("computes total = sum(scoreWord) + 10*pangrams over the scoring list only", () => {
    const game = makeGame(data);
    let expected = 0;
    for (const w of game.revealList) {
      expected += w.length > 4 ? w.length : 1;
      if (new Set(w).size === 7) expected += 10;
    }
    expect(game.total).toBe(expected);
  });

  it("makeCustomGame returns a puzzle for the chosen letters", () => {
    // bdeintr — valid puzzle (no s, has 2 vowels e/i, no q)
    const game = makeCustomGame(data, "bdeint", "r");
    expect(game.center).toBe("r");
    expect(new Set(game.letters)).toEqual(new Set("bdeint"));
    expect(game.wordlist.length).toBeGreaterThan(0);
    for (const w of game.wordlist) {
      expect(w).toContain("r");
      for (const ch of w) expect("bdeintr").toContain(ch);
    }
  });
});

describe("validateCustomLetters", () => {
  it("accepts valid input", () => {
    expect(validateCustomLetters("bdeint", "r")).toBeNull();
  });
  it("requires center of length 1", () => {
    expect(validateCustomLetters("bdeint", "")).toMatch(/Center/);
    expect(validateCustomLetters("bdeint", "rx")).toMatch(/Center/);
  });
  it("requires 6 outer letters", () => {
    expect(validateCustomLetters("bdein", "r")).toMatch(/6/);
    expect(validateCustomLetters("bdeintx", "r")).toMatch(/6/);
  });
  it("requires distinct letters", () => {
    expect(validateCustomLetters("bdeinr", "r")).toMatch(/distinct/);
    expect(validateCustomLetters("bdeinn", "r")).toMatch(/distinct/);
  });
  it("requires only a-z characters", () => {
    expect(validateCustomLetters("bdein1", "r")).toMatch(/a–z/);
    expect(validateCustomLetters("bdeint", "1")).toMatch(/letter/);
  });
  it("allows 's' (puzzle rules are bypassed for custom)", () => {
    expect(validateCustomLetters("bdeins", "r")).toBeNull();
  });
  it("allows 'q' without 'u' (rules bypassed)", () => {
    expect(validateCustomLetters("bdeinq", "r")).toBeNull();
  });
  it("allows fewer than 2 vowels (rules bypassed)", () => {
    expect(validateCustomLetters("bcdfgh", "r")).toBeNull();
  });
});
