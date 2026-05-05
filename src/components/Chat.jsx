import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// Chat popover for multi games. Owns its open/closed state and read
// counter. Parent (Game) holds a ref so it can imperatively open the
// popover and focus the input when the player Tabs out of the word
// box; Tab from the chat input fires `onTabAway` so the parent can
// hand focus back.
const Chat = forwardRef(function Chat(
  { gameId, playerId, players, messages, onTabAway },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // Treat any messages that are already there at mount as unread until the
  // player explicitly opens the popover.
  const [lastReadCount, setLastReadCount] = useState(0);
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const listEndRef = useRef(null);

  useImperativeHandle(ref, () => ({
    openAndFocus: () => {
      setOpen(true);
      // Focus has to wait until the popover renders.
      setTimeout(() => inputRef.current?.focus(), 0);
    },
  }));

  // Mark all current messages read on open.
  useEffect(() => {
    if (open) setLastReadCount(messages.length);
  }, [open, messages.length]);

  // Auto-scroll to the bottom whenever a new message lands while open.
  useEffect(() => {
    if (!open) return;
    const el = listEndRef.current;
    // jsdom doesn't implement scrollIntoView; guard so tests don't blow up.
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "end" });
    }
  }, [messages.length, open]);

  const unread = Math.max(0, messages.length - lastReadCount);
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const lastSender = lastMsg
    ? players.find((p) => p.playerId === lastMsg.playerId)
    : null;
  const unreadColor = unread > 0 && lastSender ? lastSender.color : null;

  const playerById = new Map(players.map((p) => [p.playerId, p]));

  async function handleSubmit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setText("");
    try {
      await fetch(`/api/games/${gameId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId, text: value }),
      });
    } catch {
      // The WS broadcast will or won't reflect it; nothing else to do.
    } finally {
      setSending(false);
    }
  }

  function handleInputKeyDown(e) {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      onTabAway?.();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`Chat-button${unreadColor ? " has-unread" : ""}`}
        onClick={() => setOpen((o) => !o)}
        style={
          unreadColor
            ? { background: unreadColor, borderColor: unreadColor }
            : undefined
        }
        aria-label="Chat"
        aria-expanded={open}
      >
        <span className="Chat-button-icon" aria-hidden="true">
          💬
        </span>
        {unread > 0 && (
          <span className="Chat-badge" aria-hidden="true">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="Chat-popover" role="dialog" aria-label="Chat">
          <div className="Chat-header">
            <span className="Chat-header-title">Chat</span>
            <button
              type="button"
              className="Chat-close"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              ×
            </button>
          </div>
          <ul className="Chat-messages">
            {messages.length === 0 && (
              <li className="Chat-empty">No messages yet.</li>
            )}
            {messages.map((msg, i) => {
              const p = playerById.get(msg.playerId);
              return (
                <li key={i} className="Chat-message">
                  <span
                    className="Chat-msg-name"
                    style={{ color: p?.color }}
                  >
                    {p?.name || "?"}
                  </span>
                  <span className="Chat-msg-text">{msg.text}</span>
                </li>
              );
            })}
            <div ref={listEndRef} />
          </ul>
          <form className="Chat-form" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Type a message"
              maxLength={500}
              autoComplete="off"
              spellCheck={false}
            />
          </form>
        </div>
      )}
    </>
  );
});

export default Chat;
