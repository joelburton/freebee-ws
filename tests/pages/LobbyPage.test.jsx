import { StrictMode } from "react";
import {
  act,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { STORAGE_KEY } from "../../src/components/storage";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

const { default: LobbyPage } = await import("../../src/pages/LobbyPage");

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  // Test helper: dispatch a state message ({ type, view }).
  emit(view, which = "state") {
    for (const fn of this.listeners.message || []) {
      fn({ data: JSON.stringify({ type: which, view }) });
    }
  }
}
FakeWebSocket.instances = [];

const baseLobby = {
  gameId: "g1",
  mode: "multi",
  state: "assembling",
  hostId: "host-1",
  players: [{ playerId: "host-1", name: "Joel", color: "#1976d2" }],
  ended: false,
};

function mockFetch(handlers) {
  global.fetch = vi.fn(async (url, opts) => {
    for (const [matcher, handler] of handlers) {
      if (matcher(url, opts)) return handler(url, opts);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderAt(gameId, { strict = false } = {}) {
  const ui = (
    <MemoryRouter initialEntries={[`/g/${gameId}`]}>
      <Routes>
        <Route path="/g/:gameId" element={<LobbyPage />} />
      </Routes>
    </MemoryRouter>
  );
  return rtlRender(strict ? <StrictMode>{ui}</StrictMode> : ui);
}

beforeEach(() => {
  navigateMock.mockClear();
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("LobbyPage", () => {
  it("redirects home with a banner when the game is unknown", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/nope",
        async () => ({ ok: false, status: 404, json: async () => ({}) }),
      ],
    ]);
    renderAt("nope");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
    );
    expect(window.sessionStorage.getItem("freebee:banner")).toMatch(
      /doesn't exist/i,
    );
  });

  it("redirects home with a banner when the gameId is a solo game", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/solo-1",
        async () => ({
          ok: true,
          json: async () => ({ ...baseLobby, mode: "solo", state: "active" }),
        }),
      ],
    ]);
    renderAt("solo-1");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
    );
    expect(window.sessionStorage.getItem("freebee:banner")).toMatch(
      /multiplayer/i,
    );
  });

  it("shows the join card when in lobby and not yet a member", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
    ]);
    renderAt("g1");
    await screen.findByRole("heading", { name: "Join group" });
    expect(screen.getByText(/Joel is waiting/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  });

  it("joins, stores playerId, and renders the lobby", async () => {
    const joined = {
      ...baseLobby,
      players: [
        ...baseLobby.players,
        { playerId: "alice-1", name: "Alice", color: "#e64a19" },
      ],
      playerId: "alice-1",
    };
    mockFetch([
      [
        (url, opts) =>
          url === "/api/games/g1" && (!opts || opts.method !== "POST"),
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
      [
        (url, opts) =>
          url === "/api/games/g1/join" && opts?.method === "POST",
        async () => ({ ok: true, json: async () => joined }),
      ],
    ]);
    const user = userEvent.setup();
    renderAt("g1");
    await screen.findByRole("heading", { name: "Join group" });
    await user.type(screen.getByPlaceholderText("Name"), "Alice");
    await user.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("heading", { name: "Lobby" });
    expect(screen.getByText("Alice")).toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    expect(stored).toEqual({ gameId: "g1", playerId: "alice-1" });
  });

  it("reconnects via saved playerId without showing the join card", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
    ]);
    renderAt("g1");
    await screen.findByRole("heading", { name: "Lobby" });
    expect(screen.queryByRole("heading", { name: "Join group" })).toBeNull();
  });

  it("solo lobby (alone) shows 'waiting for friends' hint with Start setup enabled", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
    ]);
    renderAt("g1");
    const btn = await screen.findByRole("button", { name: /Start setup/i });
    expect(btn).toBeEnabled();
    expect(
      screen.getByText(/Waiting for friends to join/i),
    ).toBeInTheDocument();
  });

  it("once a friend has joined, the hint switches to 'pick game options'", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    const lobbyWithBuddy = {
      ...baseLobby,
      players: [
        ...baseLobby.players,
        { playerId: "buddy-1", name: "Buddy", color: "#e64a19" },
      ],
    };
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => lobbyWithBuddy }),
      ],
    ]);
    renderAt("g1");
    await screen.findByRole("button", { name: /Start setup/i });
    expect(
      screen.getByText(/pick game options for everyone/i),
    ).toBeInTheDocument();
  });

  it("blocks strangers when the game has already started", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({ ...baseLobby, state: "active" }),
        }),
      ],
    ]);
    renderAt("g1");
    expect(
      await screen.findByRole("heading", { name: "Game already started" }),
    ).toBeInTheDocument();
  });

  it("members on a started game are redirected to /play", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({ ...baseLobby, state: "active" }),
        }),
      ],
    ]);
    renderAt("g1");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g1/play", {
        replace: true,
      }),
    );
  });

  it("greys out offline players in the lobby roster", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({
            ...baseLobby,
            players: [
              { ...baseLobby.players[0], online: true },
              {
                playerId: "afk-1",
                name: "Afk",
                color: "#e64a19",
                online: false,
              },
            ],
          }),
        }),
      ],
    ]);
    renderAt("g1");
    await screen.findByRole("heading", { name: "Lobby" });
    const players = document.querySelectorAll(".App-lobby-player");
    expect(players[0].classList.contains("is-offline")).toBe(false);
    expect(players[1].classList.contains("is-offline")).toBe(true);
  });

  it("opens the WS stream with playerId in the URL after joining", async () => {
    const joined = {
      ...baseLobby,
      players: [
        ...baseLobby.players,
        { playerId: "alice-1", name: "Alice", color: "#e64a19" },
      ],
      playerId: "alice-1",
    };
    mockFetch([
      [
        (url, opts) =>
          url === "/api/games/g1" && (!opts || opts.method !== "POST"),
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
      [
        (url, opts) =>
          url === "/api/games/g1/join" && opts?.method === "POST",
        async () => ({ ok: true, json: async () => joined }),
      ],
    ]);
    const user = userEvent.setup();
    renderAt("g1");
    await screen.findByRole("heading", { name: "Join group" });
    await user.type(screen.getByPlaceholderText("Name"), "Alice");
    await user.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => {
      const last = FakeWebSocket.instances.at(-1);
      expect(last.url).toBe("ws://localhost:3000/ws/g1?playerId=alice-1");
    });
  });

  it("loads the lobby under StrictMode (regression: double-mount must not cancel-and-skip)", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
    ]);
    renderAt("g1", { strict: true });
    await screen.findByRole("heading", { name: "Join group" });
  });

  it("live WS state events update the lobby roster", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
    ]);
    renderAt("g1");
    await screen.findByRole("heading", { name: "Lobby" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
      FakeWebSocket.instances[0].emit({
        ...baseLobby,
        players: [
          ...baseLobby.players,
          { playerId: "buddy-1", name: "Buddy", color: "#e64a19" },
        ],
      });
    });
    expect(screen.getByText("Buddy")).toBeInTheDocument();
  });

  it("WS state with state===active navigates members to /play", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
    ]);
    renderAt("g1");
    await screen.findByRole("heading", { name: "Lobby" });
    act(() => {
      FakeWebSocket.instances[0].emit({ ...baseLobby, state: "active" });
    });
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g1/play", {
        replace: true,
      }),
    );
  });
});

// Phase-2 in-group configure flow. Players take turns owning a setup
// form; the owner's edits sync to non-owners as a read-only mirror via
// /configure/update + WS state pushes. Commit cuts a session straight
// to active.
describe("LobbyPage configure flow", () => {
  // Snapshot all calls into postedBodies; tests assert on the most
  // recent, ignoring the initial-mount draft push.
  function configureMock(view, postedBodies) {
    mockFetch([
      [
        (url, opts) =>
          url === "/api/games/g1" && (!opts || opts.method !== "POST"),
        async () => ({ ok: true, json: async () => view }),
      ],
      [
        (url, opts) => url.startsWith("/api/games/g1/") && opts?.method === "POST",
        async (url, opts) => {
          postedBodies.push({ url, body: JSON.parse(opts.body) });
          return { ok: true, json: async () => view };
        },
      ],
    ]);
  }

  function asConfigurator() {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
  }

  it("'Start setup' on an assembling group POSTs /configure", async () => {
    asConfigurator();
    const posted = [];
    configureMock(baseLobby, posted);
    const user = userEvent.setup();
    renderAt("g1");
    const btn = await screen.findByRole("button", { name: /Start setup/i });
    await user.click(btn);
    await waitFor(() =>
      expect(posted.some((p) => p.url === "/api/games/g1/configure")).toBe(true),
    );
    const claim = posted.find((p) => p.url === "/api/games/g1/configure");
    expect(claim.body).toEqual({ playerId: "host-1" });
  });

  it("the configurator sees the editable form (Cancel button visible)", async () => {
    asConfigurator();
    const view = {
      ...baseLobby,
      state: "configuring",
      configuring: { ownerId: "host-1", draft: null },
    };
    configureMock(view, []);
    renderAt("g1");
    await screen.findByRole("heading", { name: "Set up the next game" });
    expect(screen.getByRole("tab", { name: "Co-op" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("non-configurators see a wait message + the read-only mirror", async () => {
    // Buddy's view: someone else owns configure.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "buddy-1" }),
    );
    const view = {
      ...baseLobby,
      players: [
        ...baseLobby.players,
        { playerId: "buddy-1", name: "Buddy", color: "#e64a19" },
      ],
      state: "configuring",
      configuring: { ownerId: "host-1", draft: null },
    };
    configureMock(view, []);
    renderAt("g1");
    await screen.findByRole("heading", { name: /Joel is setting up/i });
    expect(
      screen.getByText(/Joel is picking the options/i),
    ).toBeInTheDocument();
    // Co-op tab is rendered but the form is read-only — no Cancel button.
    expect(screen.getByRole("tab", { name: "Co-op" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
  });

  it("the read-only mirror reflects view.configuring.draft", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "buddy-1" }),
    );
    const view = {
      ...baseLobby,
      players: [
        ...baseLobby.players,
        { playerId: "buddy-1", name: "Buddy", color: "#e64a19" },
      ],
      state: "configuring",
      configuring: {
        ownerId: "host-1",
        draft: { mode: "compete", endModeCompete: "rank" },
      },
    };
    configureMock(view, []);
    renderAt("g1");
    await screen.findByRole("heading", { name: /Joel is setting up/i });
    // Compete tab is the selected one.
    const competeTab = screen.getByRole("tab", { name: "Compete" });
    expect(competeTab.getAttribute("aria-selected")).toBe("true");
  });

  it("Cancel posts /configure/cancel", async () => {
    asConfigurator();
    const view = {
      ...baseLobby,
      state: "configuring",
      configuring: { ownerId: "host-1", draft: null },
    };
    const posted = [];
    configureMock(view, posted);
    const user = userEvent.setup();
    renderAt("g1");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        posted.some((p) => p.url === "/api/games/g1/configure/cancel"),
      ).toBe(true),
    );
  });

  it("clicking the Compete tab pushes a draft update with mode='compete'", async () => {
    asConfigurator();
    const view = {
      ...baseLobby,
      state: "configuring",
      configuring: { ownerId: "host-1", draft: null },
    };
    const posted = [];
    configureMock(view, posted);
    const user = userEvent.setup();
    renderAt("g1");
    // Wait for the initial-mount draft push to land first; the next
    // draft push is the one we care about.
    await waitFor(() =>
      expect(
        posted.some((p) => p.url === "/api/games/g1/configure/update"),
      ).toBe(true),
    );
    const before = posted.length;
    await user.click(screen.getByRole("tab", { name: "Compete" }));
    await waitFor(() => expect(posted.length).toBeGreaterThan(before));
    const last = posted.at(-1);
    expect(last.url).toBe("/api/games/g1/configure/update");
    expect(last.body.draft.mode).toBe("compete");
  });

  it("commit (multi default) posts /configure/commit with mode/timerMode/countdownSeconds", async () => {
    asConfigurator();
    const view = {
      ...baseLobby,
      state: "configuring",
      configuring: { ownerId: "host-1", draft: null },
    };
    const posted = [];
    configureMock(view, posted);
    const user = userEvent.setup();
    renderAt("g1");
    const go = await screen.findByRole("button", {
      name: "Start with random letters",
    });
    await user.click(go);
    await waitFor(() =>
      expect(
        posted.some((p) => p.url === "/api/games/g1/configure/commit"),
      ).toBe(true),
    );
    const commit = posted.find((p) => p.url === "/api/games/g1/configure/commit");
    // Default draft is mode=multi, timerMode="none".
    expect(commit.body).toMatchObject({
      playerId: "host-1",
      mode: "multi",
      timerMode: "none",
      countdownSeconds: 0,
    });
  });

  it("commit (compete + targetRank) threads targetRank through, omits countdownSeconds", async () => {
    asConfigurator();
    const view = {
      ...baseLobby,
      state: "configuring",
      configuring: {
        ownerId: "host-1",
        draft: {
          mode: "compete",
          endModeCompete: "rank",
          targetRankCompete: 5,
        },
      },
    };
    const posted = [];
    configureMock(view, posted);
    const user = userEvent.setup();
    renderAt("g1");
    // Owner doesn't react to incoming drafts, so we click the tab to
    // arrive at the compete branch under the owner's local state.
    await screen.findByRole("button", { name: "Start with random letters" });
    await user.click(screen.getByRole("tab", { name: "Compete" }));
    await user.click(
      screen.getByRole("button", { name: "Start with random letters" }),
    );
    await waitFor(() =>
      expect(
        posted.some((p) => p.url === "/api/games/g1/configure/commit"),
      ).toBe(true),
    );
    const commit = posted.find((p) => p.url === "/api/games/g1/configure/commit");
    expect(commit.body).toMatchObject({
      playerId: "host-1",
      mode: "compete",
      timerMode: "up",
      targetRank: 6, // DEFAULT_TARGET_RANK; the draft above is for the
      // read-only mirror, but the owner's local state stays on defaults.
    });
    expect(commit.body.countdownSeconds).toBeUndefined();
  });

  it("custom letters commit includes letters/center", async () => {
    asConfigurator();
    const view = {
      ...baseLobby,
      state: "configuring",
      configuring: { ownerId: "host-1", draft: null },
    };
    const posted = [];
    configureMock(view, posted);
    const user = userEvent.setup();
    renderAt("g1");
    await screen.findByRole("button", { name: "Start with chosen letters" });
    await user.type(screen.getByPlaceholderText("A"), "R");
    await user.type(screen.getByPlaceholderText("BCDEFG"), "BDEINT");
    await user.click(
      screen.getByRole("button", { name: "Start with chosen letters" }),
    );
    await waitFor(() =>
      expect(
        posted.some((p) => p.url === "/api/games/g1/configure/commit"),
      ).toBe(true),
    );
    const commit = posted.find((p) => p.url === "/api/games/g1/configure/commit");
    expect(commit.body.letters).toBe("bdeint");
    expect(commit.body.center).toBe("r");
  });

  it("invalid countdown keeps the form open with an error and does NOT POST commit", async () => {
    asConfigurator();
    const view = {
      ...baseLobby,
      state: "configuring",
      configuring: {
        ownerId: "host-1",
        // initialDraft only matters for read-only renders; owner's local
        // state starts at DEFAULT_DRAFT, so we drive timerMode via UI.
        draft: null,
      },
    };
    const posted = [];
    configureMock(view, posted);
    const user = userEvent.setup();
    renderAt("g1");
    await screen.findByRole("button", { name: "Start with random letters" });
    // Click the Countdown radio to switch timerMode → "down".
    const downRadio = document.querySelector('input[name="cfg-timer"][value]');
    // Easier: click the "Countdown" label text that wraps the radio.
    await user.click(screen.getByText("Countdown"));
    // Type a clearly invalid time.
    const input = screen.getByLabelText("Countdown duration");
    await user.clear(input);
    await user.type(input, "not-a-time");
    await user.click(
      screen.getByRole("button", { name: "Start with random letters" }),
    );
    expect(
      await screen.findByText(/Countdown must be M:SS/i),
    ).toBeInTheDocument();
    // No /commit POST happened (only /update pushes from typing).
    expect(
      posted.some((p) => p.url === "/api/games/g1/configure/commit"),
    ).toBe(false);
    // Form is still open.
    expect(
      screen.getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    void downRadio;
  });
});
