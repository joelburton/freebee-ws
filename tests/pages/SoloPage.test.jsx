import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

const { default: SoloPage } = await import("../../src/pages/SoloPage");

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {}
}

const baseSolo = {
  gameId: "g1",
  mode: "solo",
  state: "active",
  letters: "bdeint",
  center: "r",
  words: 4,
  total: 50,
  found: [],
  bonusFound: [],
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
  return render(
    <MemoryRouter initialEntries={[`/p/${gameId}`]}>
      <Routes>
        <Route path="/p/:gameId" element={<SoloPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockClear();
  globalThis.WebSocket = FakeWebSocket;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("SoloPage", () => {
  it("renders the Game when fetch returns a solo session", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({ ok: true, json: async () => baseSolo }),
      ],
    ]);
    renderAt("g1");
    // Outer letters appear once Game renders.
    await waitFor(() =>
      expect(screen.getByText("R")).toBeInTheDocument(),
    );
  });

  it("redirects to /g/:id when the fetched game is multi (URL-mismatch)", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({ ...baseSolo, mode: "multi" }),
        }),
      ],
    ]);
    renderAt("g1");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/g/g1", { replace: true }),
    );
  });

  it("404 sets a banner and redirects home", async () => {
    mockFetch([
      [
        (url) => url === "/api/games/missing",
        async () => ({ ok: false, status: 404, json: async () => ({}) }),
      ],
    ]);
    renderAt("missing");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
    );
    expect(window.sessionStorage.getItem("freebee:banner")).toMatch(
      /doesn't exist/i,
    );
  });

  it("New board posts /api/games carrying timer config and navigates to /p/:newId", async () => {
    // The "New board" button only appears once the current game has ended.
    const sourceSolo = {
      ...baseSolo,
      timerMode: "down",
      countdownSeconds: 90,
      ended: true,
      state: "ended",
      revealList: [],
    };
    const created = { ...baseSolo, gameId: "g2" };
    const calls = [];
    mockFetch([
      [
        (url, opts) => url === "/api/games/g1" && (!opts || opts.method !== "POST"),
        async () => ({ ok: true, json: async () => sourceSolo }),
      ],
      [
        (url, opts) => url === "/api/games" && opts?.method === "POST",
        async (_url, opts) => {
          calls.push(JSON.parse(opts.body));
          return { ok: true, json: async () => created };
        },
      ],
    ]);
    const user = userEvent.setup();
    renderAt("g1");
    await screen.findByRole("button", { name: /New board/i });
    await user.click(screen.getByRole("button", { name: /New board/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ timerMode: "down", countdownSeconds: 90 });
    expect(navigateMock).toHaveBeenCalledWith("/p/g2", { replace: true });
  });

  it("loadError state displays an error message instead of the Game", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("network down")));
    renderAt("g1");
    await waitFor(() =>
      expect(screen.getByText(/Error: network down/)).toBeInTheDocument(),
    );
    // No navigate; the page parks on the error.
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
