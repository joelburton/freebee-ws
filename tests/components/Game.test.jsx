import {
  act,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Game, { formatTime } from "../../src/components/Game";

// Game uses <Link> for the site title; provide router context for every
// render so call sites don't have to.
const render = (ui, opts) =>
  rtlRender(ui, { wrapper: MemoryRouter, ...opts });

// Stand-in for the browser's WebSocket. Game opens one to /ws/<gameId>
// and listens for { type: "state" | "heartbeat", view } messages.
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    this.readyState = FakeWebSocket.OPEN;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    for (const fn of this.listeners.close || []) fn({});
  }
  // Test helper: dispatch a message from the "server". The wire shape is
  // { type: "state"|"heartbeat", view }.
  emit(view, which = "state") {
    for (const fn of this.listeners.message || []) {
      fn({ data: JSON.stringify({ type: which, view }) });
    }
  }
  fireOpen() {
    for (const fn of this.listeners.open || []) fn({});
  }
  // Server-initiated close — like .close() but doesn't update closed.
  fireClose() {
    this.readyState = FakeWebSocket.CLOSED;
    for (const fn of this.listeners.close || []) fn({});
  }
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
});

const mockGame = {
  gameId: "g1",
  letters: "bdeint",
  center: "r",
  words: 4,
  total: 50,
  found: [],
  bonusFound: [],
  score: 0,
  ended: false,
  timerMode: "up",
  countdownSeconds: 0,
};

function mockServer({ submit = {}, end, pause, resume } = {}) {
  global.fetch = vi.fn(async (url, opts) => {
    if (typeof url === "string" && url.endsWith("/submit")) {
      const body = JSON.parse(opts.body);
      const w = body.word.toLowerCase();
      const resp = submit[w] || { result: "notAWord" };
      return { ok: true, json: async () => resp };
    }
    if (typeof url === "string" && url.endsWith("/pause")) {
      return {
        ok: true,
        json: async () => pause || { paused: true, elapsed: 0, ended: false },
      };
    }
    if (typeof url === "string" && url.endsWith("/resume")) {
      return {
        ok: true,
        json: async () => resume || { paused: false, elapsed: 0, ended: false },
      };
    }
    if (typeof url === "string" && url.endsWith("/end")) {
      return {
        ok: true,
        json: async () => end || { ended: true, revealList: [], found: [], score: 0 },
      };
    }
    return { ok: false, json: async () => ({ error: "not implemented" }) };
  });
}

function setup(overrides = {}) {
  const user = userEvent.setup();
  const utils = render(<Game game={{ ...mockGame, ...overrides }} />);
  return { user, ...utils };
}

beforeEach(() => {
  window.localStorage.removeItem("freebee:state");
  vi.restoreAllMocks();
});

describe("formatTime", () => {
  it("formats seconds as M:SS", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(7)).toBe("0:07");
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(599)).toBe("9:59");
  });
  it("includes hours when over an hour", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3725)).toBe("1:02:05");
  });
});

describe("Game · multiplayer awareness", () => {
  const multiGame = {
    ...mockGame,
    mode: "multi",
    state: "active",
    hostId: "p-host",
    players: [
      { playerId: "p-host", name: "Joel", color: "#1976d2" },
      { playerId: "p-buddy", name: "Buddy", color: "#e64a19" },
    ],
    foundBy: { tribe: "p-host", trident: "p-buddy" },
    found: ["tribe", "trident"],
    bonusFound: [],
    score: 12,
  };

  it("solo game has no roster strip", () => {
    mockServer();
    render(<Game game={mockGame} />);
    expect(document.querySelector(".Game-roster")).toBeNull();
  });

  it("multi game renders roster with each player's color and a Leave × on the viewer's row", () => {
    mockServer();
    render(
      <Game game={multiGame} playerId="p-host" onLeave={() => {}} />,
    );
    const roster = document.querySelector(".Game-roster");
    expect(roster).not.toBeNull();
    const players = roster.querySelectorAll(".Game-roster-player");
    expect(players).toHaveLength(2);
    expect(players[0].textContent).toMatch(/Joel/);
    // Self-locator is the × button (title "Leave group"), not a "you" pill.
    expect(players[0].querySelector(".Roster-leave")).not.toBeNull();
    expect(players[0].style.getPropertyValue("--player-color")).toBe("#1976d2");
    expect(players[1].textContent).toMatch(/Buddy/);
    expect(players[1].querySelector(".Roster-leave")).toBeNull();
    expect(players[1].style.getPropertyValue("--player-color")).toBe("#e64a19");
  });

  it("found-word li gets the finder's color via inline style", () => {
    mockServer();
    const { container } = render(
      <Game game={multiGame} playerId="p-host" />,
    );
    const lis = Array.from(container.querySelectorAll(".WordList li"));
    const tribe = lis.find((li) => li.textContent.startsWith("tribe"));
    const trident = lis.find((li) => li.textContent.startsWith("trident"));
    expect(tribe.style.color).toBe("rgb(25, 118, 210)"); // #1976d2
    expect(trident.style.color).toBe("rgb(230, 74, 25)"); // #e64a19
  });

  it("/ opens the chat popover and focuses its input", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<Game game={multiGame} playerId="p-host" />);
    await user.keyboard("/");
    // Popover open, chat input focused.
    expect(screen.getByRole("dialog", { name: "Chat" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Type a message")).toHaveFocus(),
    );
  });

  it("solo game renders no chat button", () => {
    mockServer();
    render(<Game game={mockGame} />);
    expect(
      screen.queryByRole("button", { name: /^Chat$/ }),
    ).toBeNull();
  });

  it("opens the SSE stream with playerId in the query string for multi", () => {
    mockServer();
    render(<Game game={multiGame} playerId="p-host" />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe(
      "ws://localhost:3000/ws/g1?playerId=p-host",
    );
  });

  it("greys out roster players whose online flag is false", () => {
    const offlineMulti = {
      ...multiGame,
      players: [
        { ...multiGame.players[0], online: true },
        { ...multiGame.players[1], online: false },
      ],
    };
    mockServer();
    const { container } = render(
      <Game game={offlineMulti} playerId="p-host" />,
    );
    const players = container.querySelectorAll(".Game-roster-player");
    expect(players[0].classList.contains("is-offline")).toBe(false);
    expect(players[1].classList.contains("is-offline")).toBe(true);
  });

  it("SSE state event updates roster and word colors", () => {
    mockServer();
    render(<Game game={multiGame} playerId="p-host" />);
    const es = FakeWebSocket.instances[0];
    act(() => {
      es.emit({
        ...multiGame,
        players: [
          ...multiGame.players,
          { playerId: "p-cee", name: "Cee", color: "#388e3c" },
        ],
        found: [...multiGame.found, "rebid"],
        foundBy: { ...multiGame.foundBy, rebid: "p-cee" },
      });
    });
    const players = document.querySelectorAll(".Game-roster-player");
    expect(players).toHaveLength(3);
    const rebid = Array.from(
      document.querySelectorAll(".WordList li"),
    ).find((li) => li.textContent.startsWith("rebid"));
    expect(rebid.style.color).toBe("rgb(56, 142, 60)"); // #388e3c
  });
});

describe("Game SSE", () => {
  it("opens an EventSource for the game on mount and closes on unmount", () => {
    mockServer();
    const { unmount } = render(<Game game={mockGame} />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://localhost:3000/ws/g1");
    unmount();
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  it("applies a 'state' event from the stream", async () => {
    mockServer();
    render(<Game game={mockGame} />);
    const es = FakeWebSocket.instances[0];
    act(() => {
      es.emit({
        gameId: "g1",
        found: ["tribe"],
        bonusFound: [],
        score: 5,
        ended: false,
        paused: false,
        elapsed: 12,
      });
    });
    expect(screen.getByText("tribe")).toBeInTheDocument();
    expect(screen.getByText("0:12")).toBeInTheDocument();
  });

  it("applies a 'heartbeat' event the same way as 'state'", async () => {
    mockServer();
    render(<Game game={mockGame} />);
    const es = FakeWebSocket.instances[0];
    act(() => {
      es.emit(
        {
          gameId: "g1",
          found: [],
          bonusFound: [],
          score: 0,
          ended: false,
          paused: true,
          elapsed: 30,
        },
        "heartbeat",
      );
    });
    // Pause state from heartbeat → Resume button visible. Time stat
    // shows PAUSE rather than the (potentially wrong) clock value
    // while the game isn't ticking.
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("PAUSE")).toBeInTheDocument();
  });

  it("ignores malformed payloads without crashing", () => {
    mockServer();
    render(<Game game={mockGame} />);
    const es = FakeWebSocket.instances[0];
    expect(() => {
      es.listeners.message[0]({ data: "not json" });
    }).not.toThrow();
  });
});

describe("Game initial state", () => {
  it("seeds state from the game prop (resumed game)", () => {
    render(
      <Game
        game={{
          ...mockGame,
          found: ["tribe"],
          bonusFound: [],
          score: 5,
          elapsed: 45,
          paused: true,
        }}
      />,
    );
    expect(screen.getByText("tribe")).toBeInTheDocument();
    // Paused on mount → time stat shows PAUSE, not the clock.
    expect(screen.getByText("PAUSE")).toBeInTheDocument();
    const sideText = document.querySelector(".Game-side").textContent;
    expect(sideText).toMatch(/5\s*\/\s*50/);
    expect(sideText).toMatch(/1\s*\/\s*4/);
  });
});

describe("Game persistence", () => {
  it("writes only {gameId} to localStorage (server owns the rest)", async () => {
    setup();
    const data = JSON.parse(window.localStorage.getItem("freebee:state"));
    expect(data).toEqual({ gameId: "g1" });
  });
});

describe("Game submit flow", () => {
  it("posts to /api/games/:id/submit and shows success on accepted", async () => {
    mockServer({
      submit: {
        tribe: {
          result: "accepted",
          word: "tribe",
          points: 5,
          isPangram: false,
          bonus: false,
          totalScore: 5,
          found: ["tribe"],
          bonusFound: [],
        },
      },
    });
    const { user } = setup();
    await user.keyboard("tribe{Enter}");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/games/g1/submit",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.getByText("TRIBE: +5")).toHaveClass("Feedback-success");
    expect(screen.getByText("tribe")).toBeInTheDocument();
  });

  it("renders pangram bonus message", async () => {
    mockServer({
      submit: {
        interbred: {
          result: "accepted",
          word: "interbred",
          points: 19,
          isPangram: true,
          bonus: false,
          totalScore: 19,
          found: ["interbred"],
          bonusFound: [],
        },
      },
    });
    const { user } = setup();
    await user.keyboard("interbred{Enter}");
    expect(screen.getByText("INTERBRED: Pangram! +19")).toHaveClass(
      "Feedback-success",
    );
  });

  it("renders bonus dot for legal-only finds via bonusFound", async () => {
    mockServer({
      submit: {
        birder: {
          result: "accepted",
          word: "birder",
          points: 6,
          isPangram: false,
          bonus: true,
          totalScore: 6,
          found: ["birder"],
          bonusFound: ["birder"],
        },
      },
    });
    const { user, container } = setup();
    await user.keyboard("birder{Enter}");
    const li = [...container.querySelectorAll(".WordList li")].find((el) =>
      el.textContent.startsWith("birder"),
    );
    expect(li).toBeDefined();
    expect(li.querySelector(".WordList-bonus")).not.toBeNull();
  });

  it("maps each error result to the correct feedback class", async () => {
    const cases = [
      { word: "qrider", result: "badLetters", match: /Bad letters/i, klass: "error" },
      { word: "rib", result: "tooShort", match: /Too short/i, klass: "error" },
      { word: "bidet", result: "missingCenter", match: /Must use center/i, klass: "error" },
      { word: "rrrrr", result: "notAWord", match: /Not a valid word/i, klass: "error" },
    ];
    for (const c of cases) {
      mockServer({ submit: { [c.word]: { result: c.result } } });
      const { user, unmount } = setup();
      await user.keyboard(`${c.word}{Enter}`);
      expect(screen.getByText(c.match)).toHaveClass(`Feedback-${c.klass}`);
      unmount();
    }
  });

  it("renders alreadyFound as warning", async () => {
    mockServer({ submit: { tribe: { result: "alreadyFound" } } });
    const { user } = setup();
    await user.keyboard("tribe{Enter}");
    expect(screen.getByText(/Already found/i)).toHaveClass("Feedback-warning");
  });

  it("greys illegal letters in the word display", async () => {
    mockServer();
    const { user, container } = setup();
    await user.keyboard("qb");
    const spans = container.querySelectorAll(".WordInput span");
    expect(spans).toHaveLength(2);
    expect(spans[0]).toHaveTextContent("Q");
    expect(spans[0]).toHaveClass("WordInput-illegal");
    expect(spans[1]).not.toHaveClass("WordInput-illegal");
  });

  it("score and word-count update from server response", async () => {
    mockServer({
      submit: {
        tribe: {
          result: "accepted",
          word: "tribe",
          points: 5,
          isPangram: false,
          bonus: false,
          totalScore: 5,
          found: ["tribe"],
          bonusFound: [],
        },
      },
    });
    const { user, container } = setup();
    expect(container.textContent).toMatch(/0\s*\/\s*50/);
    await user.keyboard("tribe{Enter}");
    const sideText = container.querySelector(".Game-side").textContent;
    expect(sideText).toMatch(/5\s*\/\s*50/);
    expect(sideText).toMatch(/1\s*\/\s*4/);
  });
});

describe("Game interactions", () => {
  it("renders the center and outer letters in uppercase", () => {
    setup();
    expect(screen.getByText("R")).toBeInTheDocument();
    for (const c of "BDEINT") {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
  });

  it("clicking a hex letter appends to the word display", async () => {
    mockServer();
    const { user, container } = setup();
    const wordDisplay = container.querySelector(".WordInput");
    await user.click(screen.getByText("B"));
    expect(wordDisplay).toHaveTextContent("B");
    await user.click(screen.getByText("R"));
    expect(wordDisplay).toHaveTextContent("BR");
  });

  it("Delete button removes the last character", async () => {
    mockServer();
    const { user, container } = setup();
    const wordDisplay = container.querySelector(".WordInput");
    await user.keyboard("abc");
    expect(wordDisplay).toHaveTextContent("ABC");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(wordDisplay).toHaveTextContent("AB");
  });

  it("Shuffle button keeps the same 6 outer letters", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Shuffle/i }));
    for (const c of "BDEINT") {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("Shuffle still works after the game has ended", async () => {
    mockServer({ end: { ended: true, revealList: [], found: [], score: 0 } });
    const user = userEvent.setup();
    render(<Game game={mockGame} />);
    await user.click(screen.getByRole("button", { name: /End game/i }));
    // Game is now ended (locked); Shuffle should still be enabled.
    const shuffle = screen.getByRole("button", { name: /Shuffle/i });
    expect(shuffle).not.toBeDisabled();
    await user.click(shuffle);
    // All seven letters still rendered.
    for (const c of "BDEINT") {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("renders an initial Time stat at 0:00", () => {
    setup();
    expect(screen.getByText("Time")).toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("toggles Pause to Resume and back", async () => {
    const user = userEvent.setup();
    render(<Game game={mockGame} />);
    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause).toHaveTextContent("⏸");
    await user.click(pause);
    expect(screen.getByRole("button", { name: "Resume" })).toHaveTextContent("▶");
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByRole("button", { name: "Pause" })).toHaveTextContent("⏸");
  });

  it("with timerMode='none', shows '—' and no pause button", () => {
    render(<Game game={{ ...mockGame, timerMode: "none" }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("with timerMode='down', initial display is the countdown total", () => {
    render(
      <Game game={{ ...mockGame, timerMode: "down", countdownSeconds: 75 }} />,
    );
    expect(screen.getByText("1:15")).toBeInTheDocument();
  });

  it("auto-ends when the countdown reaches 0 and posts to /end", async () => {
    mockServer({
      end: {
        ended: true,
        revealList: ["tribe"],
        found: [],
        score: 0,
      },
    });
    const { container } = render(
      <Game game={{ ...mockGame, timerMode: "down", countdownSeconds: 0 }} />,
    );
    // Once ended, End-game button disappears and New board / New setup take its place.
    await screen.findByRole("button", { name: /New board/i });
    expect(screen.queryByRole("button", { name: /End game/i })).toBeNull();
    expect(screen.getByText(/Time's up/)).toBeInTheDocument();
    expect(container.querySelector(".Game-form")).toHaveClass("is-locked");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/games/g1/end",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("End game posts /end and reveals server-provided revealList", async () => {
    mockServer({
      end: {
        ended: true,
        revealList: ["tribe", "trident", "interbred", "rebid"],
        found: [],
        score: 0,
      },
    });
    const { user, container } = setup();
    // Empty state renders one placeholder <li> ("No words yet") so the
    // box height stays constant.
    expect(
      container.querySelectorAll(".WordList li:not(.WordList-empty)"),
    ).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /End game/i }));
    await screen.findByText("tribe");
    const items = container.querySelectorAll(
      ".WordList li:not(.WordList-empty)",
    );
    expect(items).toHaveLength(4);
    expect(container.querySelector(".Game-form")).toHaveClass("is-locked");
    // After ending: action bar swaps from End-game to New-board / New-setup.
    expect(screen.queryByRole("button", { name: /End game/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /New board/i }),
    ).toBeInTheDocument();
  });

  it("action bar swaps End game ⇄ New board / New setup based on game state", async () => {
    mockServer({ end: { ended: true, revealList: [], found: [], score: 0 } });
    const onNewGame = vi.fn();
    const onResetSetup = vi.fn();
    const user = userEvent.setup();
    render(
      <Game
        game={mockGame}
        onNewGame={onNewGame}
        onResetSetup={onResetSetup}
      />,
    );
    // While playing: only End game is visible.
    expect(
      screen.getByRole("button", { name: /End game/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New board/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /New setup/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /End game/i }));

    // After ending: End game gone, New board / New setup appear.
    expect(screen.queryByRole("button", { name: /End game/i })).toBeNull();
    const newBoard = await screen.findByRole("button", {
      name: /New board/i,
    });
    const newSetup = screen.getByRole("button", { name: /New setup/i });
    await user.click(newBoard);
    expect(onNewGame).toHaveBeenCalledTimes(1);
    await user.click(newSetup);
    expect(onResetSetup).toHaveBeenCalledTimes(1);
  });

  it("pause blurs board and word list", async () => {
    const user = userEvent.setup();
    const { container } = render(<Game game={mockGame} />);
    const form = container.querySelector(".Game-form");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(form).toHaveClass("is-blurred");
    expect(container.querySelector(".Game-side .is-blurred")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(form).not.toHaveClass("is-blurred");
  });

  describe("compete mode", () => {
    const competeBase = {
      ...mockGame,
      mode: "compete",
      players: [
        { playerId: "p-host", name: "Joel", color: "#1976d2", online: true,
          score: 5, foundCount: 1 },
        { playerId: "p-buddy", name: "Buddy", color: "#e64a19", online: true,
          score: 12, foundCount: 2 },
      ],
    };

    it("renders the leaderboard sorted by score with name + score + count", () => {
      mockServer();
      render(
        <Game
          game={competeBase}
          playerId="p-host"
          onNewGame={() => {}}
          onResetSetup={() => {}}
        />,
      );
      const list = screen.getByRole("list", { name: "Leaderboard" });
      const rows = list.querySelectorAll("li");
      // Buddy's score 12 > Joel's 5, so Buddy first.
      expect(rows[0]).toHaveTextContent("Buddy");
      expect(rows[0]).toHaveTextContent("12");
      expect(rows[1]).toHaveTextContent("Joel");
      expect(rows[1]).toHaveTextContent("5");
    });

    it("post-end: shows winner banner naming the winner", () => {
      mockServer();
      render(
        <Game
          game={{
            ...competeBase,
            ended: true,
            winnerId: "p-buddy",
            revealList: ["tribe", "rebind", "trident"],
            missedByMe: { rebind: "p-buddy", trident: "p-buddy" },
            found: ["tribe"],
          }}
          playerId="p-host"
          onNewGame={() => {}}
          onResetSetup={() => {}}
        />,
      );
      const banner = screen.getByRole("status");
      expect(banner).toHaveTextContent("Buddy");
      expect(banner).toHaveTextContent("wins");
    });

    it("post-end wordlist excludes the viewer's own finds and shows others' finds + unfound", () => {
      mockServer();
      const { container } = render(
        <Game
          game={{
            ...competeBase,
            ended: true,
            winnerId: "p-buddy",
            revealList: ["tribe", "rebind", "trident", "interbred"],
            missedByMe: { rebind: "p-buddy", trident: "p-buddy" },
            found: ["tribe"],
          }}
          playerId="p-host"
          onNewGame={() => {}}
          onResetSetup={() => {}}
        />,
      );
      const items = Array.from(
        container.querySelectorAll(".WordList li"),
      );
      const texts = items.map((li) => li.textContent);
      // "tribe" (host's own find) is excluded entirely.
      expect(texts).not.toContain("tribe");
      // Buddy's finds appear (colored — text color is the finder color).
      expect(texts).toContain("rebind");
      expect(texts).toContain("trident");
      // Word nobody found shows as unfound.
      const interbred = items.find((li) =>
        li.textContent.startsWith("interbred"),
      );
      expect(interbred.classList.contains("WordList-unfound")).toBe(true);
      const rebind = items.find((li) =>
        li.textContent.startsWith("rebind"),
      );
      expect(rebind.classList.contains("WordList-unfound")).toBe(false);
    });
  });

  it("Pause click POSTs /pause and applies the response", async () => {
    mockServer({
      pause: { paused: true, elapsed: 42, ended: false },
      resume: { paused: false, elapsed: 42, ended: false },
    });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/games/g1/pause",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    // After server response, button shows Resume and the time stat
    // is replaced by the PAUSE label.
    await screen.findByRole("button", { name: "Resume" });
    expect(screen.getByText("PAUSE")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/games/g1/resume",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await screen.findByRole("button", { name: "Pause" });
  });
});

describe("Game: Reconnecting pill", () => {
  it("does NOT show on initial mount before the first connection", () => {
    setup();
    expect(screen.queryByText(/Reconnecting/i)).not.toBeInTheDocument();
  });

  it("does NOT show for a quick blip (under the 1s grace)", () => {
    vi.useFakeTimers();
    try {
      setup();
      const ws = FakeWebSocket.instances.at(-1);
      act(() => ws.fireOpen());
      act(() => ws.fireClose());
      // Re-opens during the 1s grace.
      act(() => vi.advanceTimersByTime(800));
      expect(screen.queryByText(/Reconnecting/i)).not.toBeInTheDocument();
      const ws2 = FakeWebSocket.instances.at(-1);
      act(() => ws2.fireOpen());
      act(() => vi.advanceTimersByTime(2000));
      expect(screen.queryByText(/Reconnecting/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows after the reconnecting state has lasted ≥ 1s", async () => {
    vi.useFakeTimers();
    try {
      setup();
      const ws = FakeWebSocket.instances.at(-1);
      act(() => ws.fireOpen());
      act(() => ws.fireClose());
      // Just before the grace expires: still hidden.
      act(() => vi.advanceTimersByTime(900));
      expect(screen.queryByText(/Reconnecting/i)).not.toBeInTheDocument();
      // Past the grace.
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getByText(/Reconnecting/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disappears once we reconnect", () => {
    vi.useFakeTimers();
    try {
      setup();
      const ws = FakeWebSocket.instances.at(-1);
      act(() => ws.fireOpen());
      act(() => ws.fireClose());
      act(() => vi.advanceTimersByTime(1500));
      expect(screen.getByText(/Reconnecting/i)).toBeInTheDocument();
      // Drive the backoff; new socket appears.
      act(() => vi.advanceTimersByTime(2000));
      const ws2 = FakeWebSocket.instances.at(-1);
      act(() => ws2.fireOpen());
      expect(screen.queryByText(/Reconnecting/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
