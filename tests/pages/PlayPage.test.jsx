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

const { default: PlayPage } = await import("../../src/pages/PlayPage");

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
  emit(view, which = "state") {
    for (const fn of this.listeners.message || []) {
      fn({ data: JSON.stringify({ type: which, view }) });
    }
  }
}
FakeWebSocket.instances = [];

const baseActive = {
  gameId: "g1",
  mode: "multi",
  state: "active",
  hostId: "host-1",
  players: [{ playerId: "host-1", name: "Joel", color: "#1976d2" }],
  letters: "bdeint",
  center: "r",
  words: 4,
  total: 50,
  found: [],
  bonusFound: [],
  foundBy: {},
  messages: [],
  score: 0,
  ended: false,
  paused: false,
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

function renderAt(gameId) {
  return rtlRender(
    <MemoryRouter initialEntries={[`/g/${gameId}/play`]}>
      <Routes>
        <Route path="/g/:gameId/play" element={<PlayPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockClear();
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("PlayPage", () => {
  it("redirects to /g/:id when state is still lobby", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({ ...baseActive, state: "lobby" }),
        }),
      ],
    ]);
    renderAt("g1");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g1", {
        replace: true,
      }),
    );
  });

  it("redirects to /p/:id for solo games", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({ ...baseActive, mode: "solo" }),
        }),
      ],
    ]);
    renderAt("g1");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/p/g1", {
        replace: true,
      }),
    );
  });

  it("redirects to /g/:id (lobby route) when no valid playerId is present", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseActive }),
      ],
    ]);
    renderAt("g1");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g1", {
        replace: true,
      }),
    );
  });

  it("renders the Game when state is active and playerId is valid", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseActive }),
      ],
    ]);
    renderAt("g1");
    // Game UI rendered: outer letters appear.
    await waitFor(() =>
      expect(screen.getByText("R")).toBeInTheDocument(),
    );
  });

  it("'New board' on an ended game POSTs /new-board and navigates", async () => {
    const ended = {
      ...baseActive,
      state: "ended",
      ended: true,
      revealList: [],
    };
    const successor = {
      ...baseActive,
      gameId: "g2",
      state: "active",
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url, opts) =>
          url === "/api/games/g1" && (!opts || opts.method !== "POST"),
        async () => ({ ok: true, json: async () => ended }),
      ],
      [
        (url, opts) =>
          url === "/api/games/g1/new-board" && opts?.method === "POST",
        async () => ({ ok: true, json: async () => successor }),
      ],
    ]);
    const user = userEvent.setup();
    renderAt("g1");
    await screen.findByRole("button", { name: /New board/i });
    await user.click(screen.getByRole("button", { name: /New board/i }));
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g2/play"),
    );
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual({
      gameId: "g2",
      playerId: "host-1",
    });
  });

  it("non-clicker is also brought forward when nextGameId arrives via WS", async () => {
    const ended = {
      ...baseActive,
      state: "ended",
      ended: true,
      revealList: [],
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => ended }),
      ],
    ]);
    renderAt("g1");
    await waitFor(() =>
      expect(
        FakeWebSocket.instances.some((ws) =>
          ws.url.startsWith("ws://localhost:3000/ws/g1"),
        ),
      ).toBe(true),
    );
    const ws = FakeWebSocket.instances.find((s) =>
      s.url.startsWith("ws://localhost:3000/ws/g1"),
    );
    act(() => {
      ws.emit({ ...ended, nextGameId: "g2" });
    });
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g2/play"),
    );
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual({
      gameId: "g2",
      playerId: "host-1",
    });
  });
});
