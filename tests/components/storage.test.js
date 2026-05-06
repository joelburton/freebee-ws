import {
  STORAGE_KEY,
  loadSavedState,
  saveState,
  clearSavedState,
  setBanner,
  takeBanner,
  loadSavedName,
  saveSavedName,
} from "../../src/components/storage";

beforeEach(() => {
  window.localStorage.clear();
});

describe("storage", () => {
  it("loadSavedState returns null when nothing is stored", () => {
    expect(loadSavedState()).toBeNull();
  });

  it("saveState then loadSavedState round-trips", () => {
    const state = { gameId: "g1", elapsed: 30, savedAt: 1700000000000 };
    saveState(state);
    expect(loadSavedState()).toEqual(state);
  });

  it("loadSavedState returns null on malformed JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadSavedState()).toBeNull();
  });

  it("loadSavedState returns null when gameId is missing", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ elapsed: 30 }));
    expect(loadSavedState()).toBeNull();
  });

  it("clearSavedState removes the entry", () => {
    saveState({ gameId: "g1", elapsed: 0 });
    expect(loadSavedState()).not.toBeNull();
    clearSavedState();
    expect(loadSavedState()).toBeNull();
  });

  it("saveState swallows setItem errors (e.g. quota exceeded)", () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      expect(() => saveState({ game: { letters: "x" } })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("loadSavedState swallows getItem errors", () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, "getItem")
      .mockImplementation(() => {
        throw new Error("disabled");
      });
    try {
      expect(loadSavedState()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("clearSavedState swallows removeItem errors", () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, "removeItem")
      .mockImplementation(() => {
        throw new Error("disabled");
      });
    try {
      expect(() => clearSavedState()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("saved name", () => {
  it("returns empty string when nothing is stored", () => {
    expect(loadSavedName()).toBe("");
  });

  it("saveSavedName then loadSavedName round-trips", () => {
    saveSavedName("Joel");
    expect(loadSavedName()).toBe("Joel");
  });

  it("trims and caps to 32 chars on save", () => {
    saveSavedName("  Joel  ");
    expect(loadSavedName()).toBe("Joel");
    saveSavedName("x".repeat(50));
    expect(loadSavedName()).toBe("x".repeat(32));
  });

  it("does not overwrite when given an empty/whitespace name", () => {
    saveSavedName("Joel");
    saveSavedName("   ");
    expect(loadSavedName()).toBe("Joel");
  });
});

describe("banner", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("setBanner + takeBanner round-trip and clear", () => {
    setBanner("Oops");
    expect(takeBanner()).toBe("Oops");
    // Cleared after read.
    expect(takeBanner()).toBeNull();
  });

  it("setBanner(null) clears the banner", () => {
    setBanner("Oops");
    setBanner(null);
    expect(takeBanner()).toBeNull();
  });

  it("takeBanner returns null when nothing is set", () => {
    expect(takeBanner()).toBeNull();
  });
});
