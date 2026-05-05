import Letter from "./Letter";

export default function Letters({ letters, center, onLetterClick }) {
  return (
    <div className="Letters">
      <Letter
        letter={center}
        isCenter
        onClick={() => onLetterClick(center)}
      />
      {letters.map((letter, i) => (
        <Letter
          key={`${letter}-${i}`}
          letter={letter}
          onClick={() => onLetterClick(letter)}
        />
      ))}
    </div>
  );
}
