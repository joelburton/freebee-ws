import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Chat from "../../src/components/Chat";

const players = [
  { playerId: "p-host", name: "Joel", color: "#1976d2" },
  { playerId: "p-buddy", name: "Buddy", color: "#e64a19" },
];

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
});

function renderChat(props = {}) {
  return render(
    <Chat
      gameId="g1"
      playerId="p-host"
      players={players}
      messages={[]}
      onTabAway={() => {}}
      {...props}
    />,
  );
}

describe("Chat", () => {
  it("renders a chat button and no popover initially", () => {
    renderChat();
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the popover on button click and closes on × ", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByRole("dialog", { name: "Chat" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking the chat button focuses the message input", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Type a message")).toHaveFocus(),
    );
  });

  it("renders messages with sender name in player color", async () => {
    const user = userEvent.setup();
    const messages = [
      { playerId: "p-host", text: "hi", ts: 1 },
      { playerId: "p-buddy", text: "hey", ts: 2 },
    ];
    renderChat({ messages });
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByText("Joel").style.color).toBe("rgb(25, 118, 210)");
    expect(screen.getByText("Buddy").style.color).toBe("rgb(230, 74, 25)");
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("hey")).toBeInTheDocument();
  });

  it("Enter submits and POSTs to /chat", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    const input = screen.getByPlaceholderText("Type a message");
    await user.type(input, "well played{Enter}");
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/games/g1/chat");
    expect(JSON.parse(opts.body)).toEqual({
      playerId: "p-host",
      text: "well played",
    });
    // Input cleared after send.
    expect(input).toHaveValue("");
  });

  it("button shows the unread state and the most recent sender's color", async () => {
    const messages = [{ playerId: "p-buddy", text: "yo", ts: 1 }];
    renderChat({ messages });
    const btn = screen.getByRole("button", { name: "Chat" });
    expect(btn.classList.contains("has-unread")).toBe(true);
    // jsdom normalizes hex to rgb in cssText.
    expect(btn.style.cssText).toMatch(/rgb\(230, 74, 25\)/);
  });

  it("opening the popover clears the unread state", async () => {
    const user = userEvent.setup();
    const messages = [{ playerId: "p-buddy", text: "yo", ts: 1 }];
    renderChat({ messages });
    const btn = screen.getByRole("button", { name: "Chat" });
    expect(btn.classList.contains("has-unread")).toBe(true);
    await user.click(btn);
    expect(btn.classList.contains("has-unread")).toBe(false);
    expect(btn.style.cssText).toBe("");
  });

  it("Tab from chat input fires onTabAway", async () => {
    const user = userEvent.setup();
    const onTabAway = vi.fn();
    renderChat({ onTabAway });
    await user.click(screen.getByRole("button", { name: "Chat" }));
    const input = screen.getByPlaceholderText("Type a message");
    input.focus();
    await user.keyboard("{Tab}");
    expect(onTabAway).toHaveBeenCalledTimes(1);
  });

  it("important messages render with the bold modifier class", async () => {
    const user = userEvent.setup();
    const messages = [
      { playerId: "p-buddy", text: "shall we start?", ts: 1, important: true },
    ];
    renderChat({ messages });
    await user.click(screen.getByRole("button", { name: "Chat" }));
    const li = screen.getByText("shall we start?").closest("li");
    expect(li.classList.contains("Chat-message-important")).toBe(true);
  });

  it("auto-opens the popover when a new important message arrives", async () => {
    function Harness() {
      const [messages, setMessages] = useState([]);
      return (
        <>
          <button
            onClick={() =>
              setMessages([
                { playerId: "p-buddy", text: "I need to leave", ts: 1, important: true },
              ])
            }
          >
            push
          </button>
          <Chat
            gameId="g1"
            playerId="p-host"
            players={players}
            messages={messages}
            onTabAway={() => {}}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByText("push"));
    expect(screen.getByRole("dialog", { name: "Chat" })).toBeInTheDocument();
  });

  it("flashes a preview popover when a new message arrives while closed", async () => {
    function Harness() {
      const [messages, setMessages] = useState([]);
      return (
        <>
          <button
            onClick={() =>
              setMessages([
                { playerId: "p-buddy", text: "hey wanna play another?", ts: 1 },
              ])
            }
          >
            push
          </button>
          <Chat
            gameId="g1"
            playerId="p-host"
            players={players}
            messages={messages}
            onTabAway={() => {}}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByText("push"));
    const preview = screen.getByRole("status");
    expect(preview).toHaveTextContent("Buddy");
    expect(preview).toHaveTextContent("hey wanna play another?");
  });

  it("opening the chat hides the preview", async () => {
    function Harness() {
      const [messages, setMessages] = useState([]);
      return (
        <>
          <button
            onClick={() =>
              setMessages([
                { playerId: "p-buddy", text: "yo", ts: 1 },
              ])
            }
          >
            push
          </button>
          <Chat
            gameId="g1"
            playerId="p-host"
            players={players}
            messages={messages}
            onTabAway={() => {}}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("push"));
    expect(screen.getByRole("status")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("important arrivals open the chat instead of flashing a preview", async () => {
    function Harness() {
      const [messages, setMessages] = useState([]);
      return (
        <>
          <button
            onClick={() =>
              setMessages([
                { playerId: "p-buddy", text: "go!", ts: 1, important: true },
              ])
            }
          >
            push
          </button>
          <Chat
            gameId="g1"
            playerId="p-host"
            players={players}
            messages={messages}
            onTabAway={() => {}}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("push"));
    // No preview — chat opened directly.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Chat" })).toBeInTheDocument();
  });

  it("does not auto-open on initial mount even if backlog ends with an important message", () => {
    const messages = [
      { playerId: "p-buddy", text: "old important", ts: 1, important: true },
    ];
    renderChat({ messages });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ref.openAndFocus opens the popover and focuses the input", async () => {
    function Harness() {
      const ref = useRef(null);
      return (
        <>
          <button onClick={() => ref.current.openAndFocus()}>open</button>
          <Chat
            ref={ref}
            gameId="g1"
            playerId="p-host"
            players={players}
            messages={[]}
            onTabAway={() => {}}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Type a message")).toHaveFocus(),
    );
  });
});
