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
const READ_COUNT_KEY = (pid) => `freebee:chat-read:${pid}`;

function loadReadCount(playerId) {
  if (!playerId || typeof window === "undefined") return 0;
  try {
    const v = window.localStorage.getItem(READ_COUNT_KEY(playerId));
    const n = v == null ? 0 : parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveReadCount(playerId, count) {
  if (!playerId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READ_COUNT_KEY(playerId), String(count));
  } catch {
    // ignore quota / disabled
  }
}

const Chat = forwardRef(function Chat(
  { gameId, playerId, players, messages, onTabAway },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // Read count is keyed by playerId in localStorage so it survives the
  // new-board transition: the parent Game component remounts on a new
  // gameId, but the playerId carries forward, so the same backlog
  // doesn't reappear as unread on the next board.
  const [lastReadCount, setLastReadCount] = useState(() =>
    loadReadCount(playerId),
  );
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const listEndRef = useRef(null);

  function openAndFocus() {
    setOpen(true);
    // Focus has to wait until the popover renders.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  useImperativeHandle(ref, () => ({ openAndFocus }));

  // Mark all current messages read on open. Persisted so a new-board
  // re-mount with the same player + carried-over backlog doesn't
  // re-flag those messages as unread.
  useEffect(() => {
    if (open) {
      setLastReadCount(messages.length);
      saveReadCount(playerId, messages.length);
    }
  }, [open, messages.length, playerId]);

  // Brief preview popover shown above the chat button when a new
  // (non-important) message arrives while the chat is closed. Cleared
  // by a timer or by the chat being opened.
  const [preview, setPreview] = useState(null);
  const previewTimerRef = useRef(null);

  // React to new messages: important → auto-open, otherwise (if closed)
  // flash a preview. Track the previous count so we only react to *new*
  // messages — without this, the popover would re-open every time the
  // parent re-renders an existing important message, and it would pop
  // on initial mount whenever the latest backlog message happens to be
  // important.
  const prevCountRef = useRef(messages.length);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = messages.length;
    if (messages.length <= prev) return;
    const arrived = messages.slice(prev);
    if (arrived.some((m) => m.important)) {
      setOpen(true);
      return;
    }
    if (open) return;
    const last = arrived[arrived.length - 1];
    const sender = players.find((p) => p.playerId === last.playerId);
    setPreview({
      name: sender?.name || "?",
      color: sender?.color,
      text:
        last.text.length > 60 ? `${last.text.slice(0, 57)}…` : last.text,
    });
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => setPreview(null), 4000);
    // `players` is intentionally excluded — we only want to flash a
    // preview when the message list actually changes, not on roster
    // re-renders that don't add a message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Hide the preview when the chat opens (it's about to show the full
  // message anyway), and clean up on unmount.
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, [open]);

  useEffect(
    () => () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    },
    [],
  );

  // Auto-scroll to the bottom whenever a new message lands while open.
  useEffect(() => {
    if (!open) return;
    const el = listEndRef.current;
    // jsdom doesn't implement scrollIntoView; guard so tests don't blow up.
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "end" });
    }
  }, [messages.length, open]);

  // Unread count excludes the viewer's own messages — they sent them,
  // they don't need to be alerted about them. Without this filter, a
  // refresh after sending a message lights up the chat button with the
  // viewer's own color until they click the bubble.
  const unreadFromOthers = messages
    .slice(lastReadCount)
    .filter((m) => m.playerId !== playerId);
  const unread = unreadFromOthers.length;
  const lastUnread = unreadFromOthers.at(-1);
  const lastSender = lastUnread
    ? players.find((p) => p.playerId === lastUnread.playerId)
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
      {preview && !open && (
        <div className="Chat-preview" role="status" aria-live="polite">
          <span className="Chat-preview-name" style={{ color: preview.color }}>
            {preview.name}
          </span>
          <span className="Chat-preview-text">{preview.text}</span>
        </div>
      )}
      <button
        type="button"
        className={`Chat-button${unreadColor ? " has-unread" : ""}`}
        onClick={() => (open ? setOpen(false) : openAndFocus())}
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
              onClick={() => {
                setOpen(false);
                // Hand focus back to the word input — closing the chat
                // is conceptually the same as Tab-away. Skip on phone:
                // focusing the input pops the on-screen keyboard, which
                // covers the board the player wanted to get back to.
                if (!window.matchMedia("(max-width: 759px)").matches) {
                  onTabAway?.();
                }
              }}
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
                <li
                  key={i}
                  className={`Chat-message${msg.important ? " Chat-message-important" : ""}`}
                >
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
