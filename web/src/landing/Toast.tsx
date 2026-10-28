import { useEffect, useRef, useState } from "react";
import { onToast } from "./notice";

export function Toast() {
  const [state, setState] = useState({ text: "", on: false });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const off = onToast((text) => {
      setState({ text, on: true });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState((s) => ({ ...s, on: false })), 2800);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, []);
  return (
    <div className={"pointer-events-none fixed bottom-13 left-1/2 z-60 max-w-[calc(100%-32px)] bg-ink px-3.5 py-2.5 [font:14px/1.4_var(--sans)] text-bg opacity-0 [transform:translate(-50%,8px)] [transition:opacity_.2s,transform_.2s_var(--ease)] [&.on]:opacity-100 [&.on]:[transform:translate(-50%,0)]" + (state.on ? " on" : "")} id="toast" role="status">
      {state.text}
    </div>
  );
}
