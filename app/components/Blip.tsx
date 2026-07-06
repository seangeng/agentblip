/** The agentblip mark: a phosphor presence dot with a radar-ping ring. */
export function Blip({
  color = "phosphor",
  className = "",
}: {
  /** phosphor = working, signal = waiting on the human */
  color?: "phosphor" | "signal";
  className?: string;
}) {
  const dot = color === "phosphor" ? "bg-phosphor-400" : "bg-signal-400";
  const ring = color === "phosphor" ? "bg-phosphor-500" : "bg-signal-400";
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex size-2 shrink-0 ${className}`}
    >
      <span
        className={`absolute inset-0 animate-radar rounded-full ${ring} opacity-75`}
      />
      <span className={`relative inline-flex size-2 rounded-full ${dot}`} />
    </span>
  );
}
