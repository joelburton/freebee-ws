export default function Letter({ letter, isCenter, onClick }) {
  return (
    <button
      type="button"
      className={`Letter ${isCenter ? "Letter-isCenter" : ""}`}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span>{letter}</span>
    </button>
  );
}
