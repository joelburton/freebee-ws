import { Hono } from "hono";

// The route's only dependency on the real DB is `lookupDefinition`;
// stubbing it lets the test stay independent of the sqlite binary
// (which is build-tied to a specific Node version).
const lookupMock = vi.fn();
vi.mock("../../server/defs.js", () => ({
  lookupDefinition: (word) => lookupMock(word),
}));

const { registerApiRoutes } = await import("../../server/routes.js");

const app = new Hono();
registerApiRoutes(app);

beforeEach(() => {
  lookupMock.mockReset();
});

describe("GET /api/define/:word", () => {
  it("returns { word, def } on a hit, with the path passed through to lookupDefinition uppercased not at all (lookupDefinition handles case)", async () => {
    lookupMock.mockReturnValue("a small social group");
    const res = await app.fetch(
      new Request("http://localhost/api/define/tribe"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      word: "tribe",
      def: "a small social group",
    });
    expect(lookupMock).toHaveBeenCalledWith("tribe");
  });

  it("404s when no definition is available", async () => {
    lookupMock.mockReturnValue(null);
    const res = await app.fetch(
      new Request("http://localhost/api/define/xyzzy"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no definition/i);
    expect(lookupMock).toHaveBeenCalledWith("xyzzy");
  });

  it("lowercases the word in the response (URL casing irrelevant)", async () => {
    lookupMock.mockReturnValue("definition body");
    const res = await app.fetch(
      new Request("http://localhost/api/define/TRIBE"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).word).toBe("tribe");
  });
});
