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
  state: "lobby",
  hostId: "host-1",
  players: [{ playerId: "host-1", name: "Joel", color: "#1976d2" }],
  letters: "bdeint",
  center: "r",
  words: 4,
  total: 50,
  found: [],
  bonusFound: [],
  foundBy: {},
  score: 0,
  ended: false,
  paused: true,
  elapsed: 0,
  timerMode: "up",
  countdownSeconds: 0,
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
    await screen.findByRole("heading", { name: "Join game" });
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
    await screen.findByRole("heading", { name: "Join game" });
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
    expect(screen.queryByRole("heading", { name: "Join game" })).toBeNull();
  });

  it("shows the host's Start button only to the host", async () => {
    const lobbyWithBuddy = {
      ...baseLobby,
      players: [
        ...baseLobby.players,
        { playerId: "buddy-1", name: "Buddy", color: "#e64a19" },
      ],
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "buddy-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => lobbyWithBuddy }),
      ],
    ]);
    renderAt("g1");
    await screen.findByRole("heading", { name: "Lobby" });
    expect(
      screen.queryByRole("button", { name: /Start game/i }),
    ).toBeNull();
    expect(screen.getByText(/Waiting for Joel to start/)).toBeInTheDocument();
  });

  it("host clicking Start posts /start and navigates to /play", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    const active = {
      ...baseLobby,
      state: "active",
      paused: false,
      elapsed: 0,
    };
    mockFetch([
      [
        (url, opts) =>
          url === "/api/games/g1" && (!opts || opts.method !== "POST"),
        async () => ({ ok: true, json: async () => baseLobby }),
      ],
      [
        (url, opts) =>
          url === "/api/games/g1/start" && opts?.method === "POST",
        async () => ({ ok: true, json: async () => active }),
      ],
    ]);
    const user = userEvent.setup();
    renderAt("g1");
    await user.click(
      await screen.findByRole("button", { name: /Start game/i }),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g1/play"),
    );
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
    await screen.findByRole("heading", { name: "Join game" });
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
    await screen.findByRole("heading", { name: "Join game" });
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
