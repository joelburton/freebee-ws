import { render, screen } from "@testing-library/react";
import RankBar, { currentRankIndex } from "../../src/components/RankBar";

describe("currentRankIndex", () => {
  it("returns 0 for score 0", () => {
    expect(currentRankIndex(0, 100)).toBe(0);
  });
  it("returns 6 (Genius) at exactly 65% of total", () => {
    expect(currentRankIndex(65, 100)).toBe(6);
  });
  it("stays at Genius beyond 65%", () => {
    expect(currentRankIndex(95, 100)).toBe(6);
  });
  it("returns Nice (3) at 40%", () => {
    // Nice threshold = 3/6 * 0.65 = 0.325; Great threshold = 4/6 * 0.65 ≈ 0.433
    expect(currentRankIndex(40, 100)).toBe(3);
  });
  it("returns Good (1) just past the 1/6 threshold", () => {
    // Good threshold = 1/6 * 0.65 ≈ 0.108
    expect(currentRankIndex(12, 100)).toBe(1);
  });
  it("handles total=0", () => {
    expect(currentRankIndex(0, 0)).toBe(0);
  });
});

describe("RankBar", () => {
  function dots() {
    return screen.getAllByRole("listitem");
  }

  it("shows Start label and only the first dot achieved at 0%", () => {
    render(<RankBar score={0} total={100} />);
    expect(screen.getByText("Start")).toBeInTheDocument();
    const ds = dots();
    expect(ds[0]).toHaveClass("Rank-dot-achieved");
    for (let i = 1; i < ds.length; i++) {
      expect(ds[i]).not.toHaveClass("Rank-dot-achieved");
    }
  });

  it("shows Genius label and all dots achieved at 65%", () => {
    render(<RankBar score={65} total={100} />);
    expect(screen.getByText("Genius")).toBeInTheDocument();
    for (const d of dots()) {
      expect(d).toHaveClass("Rank-dot-achieved");
    }
  });

  it("each dot has a tooltip with rank name and points needed", () => {
    render(<RankBar score={0} total={100} />);
    expect(screen.getByText("Start · 0 pts")).toBeInTheDocument();
    expect(screen.getByText("Good · 11 pts")).toBeInTheDocument();
    expect(screen.getByText("Solid · 22 pts")).toBeInTheDocument();
    expect(screen.getByText("Nice · 33 pts")).toBeInTheDocument();
    expect(screen.getByText("Great · 44 pts")).toBeInTheDocument();
    expect(screen.getByText("Amazing · 55 pts")).toBeInTheDocument();
    expect(screen.getByText("Genius · 65 pts")).toBeInTheDocument();
  });

  it("shows Nice and four dots achieved at 40%", () => {
    render(<RankBar score={40} total={100} />);
    expect(screen.getByText("Nice")).toBeInTheDocument();
    const ds = dots();
    for (let i = 0; i < 4; i++) {
      expect(ds[i]).toHaveClass("Rank-dot-achieved");
    }
    for (let i = 4; i < ds.length; i++) {
      expect(ds[i]).not.toHaveClass("Rank-dot-achieved");
    }
  });
});
