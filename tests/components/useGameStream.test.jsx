import { act, render, waitFor } from "@testing-library/react";
import useGameStream from "../../src/components/useGameStream";

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.readyState = FakeWebSocket.OPEN; // pretend always open until close()
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    for (const fn of this.listeners.close || []) fn({});
  }
  // Test helpers.
  fireOpen() {
    for (const fn of this.listeners.open || []) fn({});
  }
  fireMessage(view, which = "state") {
    for (const fn of this.listeners.message || []) {
      fn({ data: JSON.stringify({ type: which, view }) });
    }
  }
  // Server-side close (e.g., server restart). Distinct from .close()
  // so test can choose whether the readyState change matters.
  fireClose() {
    this.readyState = FakeWebSocket.CLOSED;
    for (const fn of this.listeners.close || []) fn({});
  }
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

function Probe({ gameId = "g1", playerId = null, onView = () => {}, onStatus }) {
  const status = useGameStream(gameId, playerId, onView);
  if (onStatus) onStatus(status);
  return null;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useGameStream", () => {
  it("opens immediately and forwards 'view' messages", () => {
    const onView = vi.fn();
    render(<Probe onView={onView} />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    act(() => ws.fireOpen());
    act(() => ws.fireMessage({ paused: false }));
    expect(onView).toHaveBeenCalledWith({ paused: false });
  });

  it("status transitions: connecting → connected → reconnecting → connected", () => {
    vi.useFakeTimers();
    const statuses = [];
    render(<Probe onStatus={(s) => statuses.push(s)} />);
    expect(statuses.at(-1)).toBe("connecting");
    const ws1 = FakeWebSocket.instances[0];
    act(() => ws1.fireOpen());
    expect(statuses.at(-1)).toBe("connected");
    act(() => ws1.fireClose());
    expect(statuses.at(-1)).toBe("reconnecting");
    // Backoff: first close → ~1s wait. Advance and watch for new socket.
    act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const ws2 = FakeWebSocket.instances.at(-1);
    act(() => ws2.fireOpen());
    expect(statuses.at(-1)).toBe("connected");
  });

  it("reconnect-attempt counter resets on a successful open", () => {
    // After a fresh connection survives, the next disconnect should
    // start the backoff over at ~1s (not jump to 5s).
    vi.useFakeTimers();
    render(<Probe />);
    const ws1 = FakeWebSocket.instances[0];
    act(() => ws1.fireOpen());
    act(() => ws1.fireClose());
    act(() => vi.advanceTimersByTime(2000));
    const ws2 = FakeWebSocket.instances.at(-1);
    act(() => ws2.fireOpen()); // counter should reset here
    act(() => ws2.fireClose());
    // If the counter reset, the next reconnect lands within ~1.2s
    // (1s base + ≤20% jitter). Use 1500ms as a safe upper bound.
    const before = FakeWebSocket.instances.length;
    act(() => vi.advanceTimersByTime(1500));
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
  });

  it("watchdog force-closes the socket if no message arrives for 15s", () => {
    vi.useFakeTimers();
    render(<Probe />);
    const ws = FakeWebSocket.instances[0];
    act(() => ws.fireOpen());
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    // 14s in: still open.
    act(() => vi.advanceTimersByTime(14000));
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    // Past the 15s deadline: watchdog kicks the socket.
    act(() => vi.advanceTimersByTime(2000));
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("each incoming message resets the watchdog", () => {
    vi.useFakeTimers();
    render(<Probe />);
    const ws = FakeWebSocket.instances[0];
    act(() => ws.fireOpen());
    // 10s in, simulate the server's heartbeat — should keep us alive.
    act(() => vi.advanceTimersByTime(10000));
    act(() => ws.fireMessage({}, "heartbeat"));
    // Another 10s; still open because the heartbeat reset the timer.
    act(() => vi.advanceTimersByTime(10000));
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
  });

  it("cleanup closes the socket and prevents reconnects", () => {
    vi.useFakeTimers();
    const { unmount } = render(<Probe />);
    const ws = FakeWebSocket.instances[0];
    act(() => ws.fireOpen());
    unmount();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    // Even after waiting through several backoff windows, no new
    // sockets should be opened.
    act(() => vi.advanceTimersByTime(30000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("uses the latest onView callback even after a re-render", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    function Owner({ which }) {
      const onView = which === "first" ? () => firstCalls++ : () => secondCalls++;
      return <Probe onView={onView} />;
    }
    const { rerender } = render(<Owner which="first" />);
    const ws = FakeWebSocket.instances[0];
    act(() => ws.fireOpen());
    act(() => ws.fireMessage({}));
    expect(firstCalls).toBe(1);
    rerender(<Owner which="second" />);
    // Need to let the ref-syncing effect run.
    await waitFor(() => {
      act(() => ws.fireMessage({}));
      expect(secondCalls).toBeGreaterThanOrEqual(1);
    });
    // The first callback is no longer invoked.
    expect(firstCalls).toBe(1);
  });
});
