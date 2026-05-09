import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

const { default: SharePage } = await import("../../src/pages/SharePage");

function mockFetch(handlers) {
  global.fetch = vi.fn(async (url, opts) => {
    for (const [matcher, handler] of handlers) {
      if (matcher(url, opts)) return handler(url, opts);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderAt(search) {
  return render(
    <MemoryRouter initialEntries={[`/share${search}`]}>
      <Routes>
        <Route path="/share" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("SharePage", () => {
  it("POSTs /api/games with the query letters/center/timer and navigates to /p/:id", async () => {
    const calls = [];
    mockFetch([
      [
        (url, opts) => url === "/api/games" && opts?.method === "POST",
        async (_url, opts) => {
          calls.push(JSON.parse(opts.body));
          return { ok: true, json: async () => ({ gameId: "g99" }) };
        },
      ],
    ]);
    renderAt(
      "?letters=BDEINT&center=R&timerMode=down&countdownSeconds=120",
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      letters: "bdeint",
      center: "r",
      timerMode: "down",
      countdownSeconds: 120,
    });
    expect(navigateMock).toHaveBeenCalledWith("/p/g99", { replace: true });
  });

  it("falls back to timerMode='up' and countdownSeconds=0 for missing/invalid params", async () => {
    const calls = [];
    mockFetch([
      [
        (url, opts) => url === "/api/games" && opts?.method === "POST",
        async (_url, opts) => {
          calls.push(JSON.parse(opts.body));
          return { ok: true, json: async () => ({ gameId: "g1" }) };
        },
      ],
    ]);
    renderAt("?letters=bdeint&center=r");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].timerMode).toBe("up");
    expect(calls[0].countdownSeconds).toBe(0);
  });

  it("rejects malformed letter params: banner + redirect home, no POST", async () => {
    global.fetch = vi.fn();
    renderAt("?letters=BAD&center=Q");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("freebee:banner")).toMatch(
      /broken/i,
    );
  });

  it("server error (e.g., no valid words): banner + redirect home", async () => {
    mockFetch([
      [
        () => true,
        async () => ({
          ok: false,
          status: 400,
          json: async () => ({ error: "No valid words for these letters" }),
        }),
      ],
    ]);
    renderAt("?letters=zxqxqx&center=z");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
    );
    expect(window.sessionStorage.getItem("freebee:banner")).toMatch(
      /no valid words/i,
    );
  });
});
