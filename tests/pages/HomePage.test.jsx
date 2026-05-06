import {
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { STORAGE_KEY } from "../../src/components/storage";
import { parseTime } from "../../src/api";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

const { default: HomePage } = await import("../../src/pages/HomePage");

const fakeGame = {
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

function mockFetch(handlers) {
  global.fetch = vi.fn(async (url, opts) => {
    for (const [matcher, handler] of handlers) {
      if (matcher(url, opts)) return handler(url, opts);
    }
    return { ok: false, json: async () => ({ error: "unhandled" }) };
  });
}

const render = (ui) => rtlRender(ui, { wrapper: MemoryRouter });

beforeEach(() => {
  navigateMock.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("parseTime", () => {
  it("parses M:SS", () => {
    expect(parseTime("5:00")).toBe(300);
    expect(parseTime("0:30")).toBe(30);
  });
  it("parses MM:SS", () => {
    expect(parseTime("12:34")).toBe(754);
  });
  it("trims whitespace", () => {
    expect(parseTime("  5:00 ")).toBe(300);
  });
  it("returns null for invalid input", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("5")).toBeNull();
    expect(parseTime("5:")).toBeNull();
    expect(parseTime(":30")).toBeNull();
  });
  it("returns null for zero duration", () => {
    expect(parseTime("0:00")).toBeNull();
  });
});

describe("HomePage", () => {
  it("Start (random solo) POSTs /api/games and navigates to /p/<id>", async () => {
    mockFetch([
      [
        (url, opts) => url === "/api/games" && opts?.method === "POST",
        async () => ({ ok: true, json: async () => fakeGame }),
      ],
    ]);
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(
      screen.getByRole("button", { name: /Start with random letters/i }),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/p/g1"),
    );
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/games");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.timerMode).toBe("none");
    expect(body.letters).toBeUndefined();
    // Saved state for resume.
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    expect(stored).toEqual({ gameId: "g1" });
  });

  it("shows the API error when create returns !ok", async () => {
    mockFetch([
      [
        () => true,
        async () => ({
          ok: false,
          json: async () => ({ error: "No valid words" }),
        }),
      ],
    ]);
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(
      screen.getByRole("button", { name: /Start with random letters/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("No valid words")).toBeInTheDocument(),
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("falls back to a generic error when the body has none", async () => {
    mockFetch([
      [() => true, async () => ({ ok: false, json: async () => ({}) })],
    ]);
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(
      screen.getByRole("button", { name: /Start with random letters/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Request failed/i)).toBeInTheDocument(),
    );
  });

  it("custom-letters submit posts lowercase letters/center in the body", async () => {
    mockFetch([
      [() => true, async () => ({ ok: true, json: async () => fakeGame })],
    ]);
    const user = userEvent.setup();
    render(<HomePage />);
    const panel = within(
      screen.getByRole("tabpanel", { name: "Solo" }),
    );
    await user.type(panel.getByPlaceholderText("A"), "R");
    await user.type(panel.getByPlaceholderText("BCDEFG"), "BDEINT");
    await user.click(
      panel.getByRole("button", { name: /Start with chosen letters/i }),
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/games");
    const body = JSON.parse(opts.body);
    expect(body.letters).toBe("bdeint");
    expect(body.center).toBe("r");
  });

  it("Go button is disabled until both inputs are full", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    const panel = within(
      screen.getByRole("tabpanel", { name: "Solo" }),
    );
    const go = panel.getByRole("button", {
      name: /Start with chosen letters/i,
    });
    expect(go).toBeDisabled();
    await user.type(panel.getByPlaceholderText("A"), "R");
    expect(go).toBeDisabled();
    await user.type(panel.getByPlaceholderText("BCDEFG"), "BDEINT");
    expect(go).not.toBeDisabled();
  });

  it("rejects malformed countdown without firing a create", async () => {
    global.fetch = vi.fn();
    const user = userEvent.setup();
    render(<HomePage />);
    const panel = within(
      screen.getByRole("tabpanel", { name: "Solo" }),
    );
    await user.click(panel.getByRole("radio", { name: /Countdown/ }));
    const countdownInput = panel.getByLabelText("Countdown duration");
    await user.clear(countdownInput);
    await user.type(countdownInput, "abc");
    await user.click(
      panel.getByRole("button", { name: /Start with random letters/i }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Countdown must be M:SS/)).toBeInTheDocument();
  });

  it("on mount, GETs the saved gameId and shows the Resume card", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({
            ...fakeGame,
            found: ["tribe"],
            score: 5,
            elapsed: 30,
          }),
        }),
      ],
    ]);
    const user = userEvent.setup();
    render(<HomePage />);
    const cont = await screen.findByRole("button", {
      name: /Resume saved game/i,
    });
    expect(cont.textContent).toMatch(/1\s*\/\s*4/);
    expect(cont.textContent).toMatch(/5 pts/);
    await user.click(cont);
    expect(navigateMock).toHaveBeenCalledWith("/p/g1");
  });

  it("clears local pointer when the saved gameId 404s", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "missing" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/missing",
        async () => ({ ok: false, status: 404, json: async () => ({}) }),
      ],
    ]);
    render(<HomePage />);
    await waitFor(() =>
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: /Resume saved game/i }),
    ).toBeNull();
  });

  it("does not show Resume when no saved state", () => {
    render(<HomePage />);
    expect(
      screen.queryByRole("button", { name: /Resume saved game/i }),
    ).toBeNull();
  });

  it("shows a one-shot banner from sessionStorage and clears it on read", async () => {
    window.sessionStorage.setItem(
      "freebee:banner",
      "That game doesn't exist.",
    );
    render(<HomePage />);
    expect(await screen.findByText(/doesn't exist/i)).toBeInTheDocument();
    expect(window.sessionStorage.getItem("freebee:banner")).toBeNull();
  });

  it("dismiss button removes the banner", async () => {
    window.sessionStorage.setItem("freebee:banner", "Oops.");
    const user = userEvent.setup();
    render(<HomePage />);
    await screen.findByText("Oops.");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Oops.")).toBeNull();
  });

  it("does not surface multi saved state as a Resume card", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gameId: "g1", playerId: "host-1" }),
    );
    mockFetch([
      [
        (url) => url === "/api/games/g1",
        async () => ({
          ok: true,
          json: async () => ({ ...fakeGame, mode: "multi" }),
        }),
      ],
    ]);
    render(<HomePage />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Resume saved game/i }),
    ).toBeNull();
  });
});

describe('HomePage · "Play with friends" tab', () => {
  async function openFriendsTab(user) {
    await user.click(screen.getByRole("tab", { name: /Play with friends/i }));
  }

  it("solo tab shows by default; friends controls aren't rendered", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("tabpanel", { name: "Solo" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Create group and invite friends/i,
      }),
    ).toBeNull();
  });

  it("disables Go until a name is entered", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await openFriendsTab(user);
    expect(
      screen.getByRole("button", {
        name: /Create group and invite friends/i,
      }),
    ).toBeDisabled();
  });

  it("name field label is marked required (red) when empty, normal once filled", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await openFriendsTab(user);
    const nameInput = screen.getByPlaceholderText("Name");
    expect(
      nameInput.closest("label").classList.contains("is-required-empty"),
    ).toBe(true);
    expect(nameInput).toBeRequired();
    await user.type(nameInput, "Joel");
    expect(
      nameInput.closest("label").classList.contains("is-required-empty"),
    ).toBe(false);
  });

  it("posts to /api/groups, navigates to /g/<id>, saves localStorage + name", async () => {
    mockFetch([
      [
        (url, opts) => url === "/api/groups" && opts?.method === "POST",
        async () => ({
          ok: true,
          json: async () => ({
            gameId: "g1",
            state: "assembling",
            playerId: "host-1",
            hostId: "host-1",
            players: [
              { playerId: "host-1", name: "Joel", color: "#1976d2", online: true },
            ],
            messages: [],
          }),
        }),
      ],
    ]);
    const user = userEvent.setup();
    render(<HomePage />);
    await openFriendsTab(user);
    await user.type(screen.getByPlaceholderText("Name"), "Joel");
    await user.click(
      screen.getByRole("button", {
        name: /Create group and invite friends/i,
      }),
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/groups");
    expect(JSON.parse(opts.body)).toEqual({ playerName: "Joel" });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/g/g1"));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual({
      gameId: "g1",
      playerId: "host-1",
    });
    expect(window.localStorage.getItem("freebee:name")).toBe("Joel");
  });
});
