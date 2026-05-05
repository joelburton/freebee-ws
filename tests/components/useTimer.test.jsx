import { act, renderHook } from "@testing-library/react";
import useTimer from "../../src/components/useTimer";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useTimer", () => {
  it("interpolates seconds locally between server anchors", () => {
    const { result } = renderHook(() =>
      useTimer({
        mode: "up",
        countdownSeconds: 0,
        serverElapsed: 10,
        paused: false,
        ended: false,
      }),
    );
    expect(result.current.displayTime).toBe(10);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.displayTime).toBe(13);
  });

  it("freezes when paused and resumes from anchor when paused→running", () => {
    const { result, rerender } = renderHook(
      ({ serverElapsed, paused }) =>
        useTimer({
          mode: "up",
          countdownSeconds: 0,
          serverElapsed,
          paused,
          ended: false,
        }),
      { initialProps: { serverElapsed: 0, paused: false } },
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.displayTime).toBe(5);

    // Pause: server returns serverElapsed=5, paused=true.
    rerender({ serverElapsed: 5, paused: true });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current.displayTime).toBe(5);

    // Resume: server still says elapsed=5, paused=false.
    rerender({ serverElapsed: 5, paused: false });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.displayTime).toBe(7);
  });

  it("countdown mode: displayTime is remaining; timeUp at 0", () => {
    const { result } = renderHook(() =>
      useTimer({
        mode: "down",
        countdownSeconds: 10,
        serverElapsed: 7,
        paused: false,
        ended: false,
      }),
    );
    expect(result.current.displayTime).toBe(3);
    expect(result.current.timeUp).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.displayTime).toBe(0);
    expect(result.current.timeUp).toBe(true);
  });

  it("mode='none' does not tick", () => {
    const { result } = renderHook(() =>
      useTimer({
        mode: "none",
        countdownSeconds: 0,
        serverElapsed: 0,
        paused: true,
        ended: false,
      }),
    );
    expect(result.current.displayTime).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current.displayTime).toBe(0);
  });

  it("resuming after a long pause does not flash a stale value", () => {
    // Regression for a bug where the hook read a stale `now` snapshot
    // captured before the pause, so the first render after resume showed
    // a value one tick behind.
    const { result, rerender } = renderHook(
      ({ serverElapsed, paused }) =>
        useTimer({
          mode: "up",
          countdownSeconds: 0,
          serverElapsed,
          paused,
          ended: false,
        }),
      { initialProps: { serverElapsed: 0, paused: false } },
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.displayTime).toBe(5);
    rerender({ serverElapsed: 5, paused: true });
    // Real time keeps advancing while paused.
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(result.current.displayTime).toBe(5);
    // Resume: the very first render after the prop change must read 5,
    // not 5 - 30 (the bug) or any other stale-clock artifact.
    rerender({ serverElapsed: 5, paused: false });
    expect(result.current.displayTime).toBe(5);
  });

  it("heartbeat serverElapsed updates do not reset the local tick phase", () => {
    // Regression: every SSE heartbeat (every 5s) was re-anchoring, which
    // reset the 1Hz tick start so seconds visibly stretched or shrank
    // around each heartbeat. The hook should ignore serverElapsed changes
    // when paused/ended haven't toggled, and trust the local clock.
    const { result, rerender } = renderHook(
      ({ serverElapsed }) =>
        useTimer({
          mode: "up",
          countdownSeconds: 0,
          serverElapsed,
          paused: false,
          ended: false,
        }),
      { initialProps: { serverElapsed: 0 } },
    );
    // Tick to 4.5 seconds: display = 4.
    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(result.current.displayTime).toBe(4);
    // Heartbeat arrives mid-second with serverElapsed=4. Old behavior
    // would re-anchor here and shift the next tick's boundary.
    rerender({ serverElapsed: 4 });
    // 500ms later, display should advance to 5 (continuing the original
    // 1Hz cadence), not stay at 4 because of a fresh anchor.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.displayTime).toBe(5);
  });

  it("ended freezes the display regardless of mode", () => {
    const { result, rerender } = renderHook(
      ({ ended }) =>
        useTimer({
          mode: "up",
          countdownSeconds: 0,
          serverElapsed: 42,
          paused: false,
          ended,
        }),
      { initialProps: { ended: false } },
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.displayTime).toBe(44);
    rerender({ ended: true });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current.displayTime).toBe(42);
  });
});
