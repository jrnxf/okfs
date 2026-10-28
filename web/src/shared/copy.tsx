import { useEffect, useRef, useState } from "react";

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** A button that copies `text` and says so for a moment: "Copied", or "Select it" when the browser said no. */
export function CopyButton({ text, className, label = "Copy" }: { text: string; className: string; label?: string }) {
  const [shown, setShown] = useState(label);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        setShown((await copyText(text)) ? "Copied" : "Select it");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setShown(label), 1400);
      }}
    >
      {shown}
    </button>
  );
}
