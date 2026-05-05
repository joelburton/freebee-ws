export default function Feedback({ message, type }) {
  return (
    <div className="Feedback">
      {message && (
        <span className={`Feedback-message Feedback-${type}`}>{message}</span>
      )}
    </div>
  );
}
