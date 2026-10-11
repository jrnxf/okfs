// The theme switcher and the list of keys.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { config } from "./config";
import { MOD } from "./palette";
import { store } from "./store";
import { type Scheme, active, isDark, setScheme, setTheme } from "./theme";

const SCHEMES: Scheme[] = ["light", "dark", "auto"];
const WIDTH = 248;

/** A popover under (or over) the button that opened it. */
export function ThemeMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);

  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const box = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(box.right - WIDTH, innerWidth - WIDTH - 8))}px`;
    if (box.top > innerHeight / 2) el.style.bottom = `${innerHeight - box.top + 8}px`;
    else el.style.top = `${box.bottom + 8}px`;
  }, [anchor]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!pop.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchor, onClose]);

  const dark = isDark();
  const then = (change: () => void) => () => {
    change();
    redraw((n) => n + 1);
  };
  return (
    <div class="pop" role="dialog" aria-label="Theme" ref={pop}>
      <div class="seg">
        {SCHEMES.map((scheme) => (
          <button aria-pressed={active.scheme === scheme} onClick={then(() => setScheme(scheme))}>
            {scheme[0]?.toUpperCase() + scheme.slice(1)}
          </button>
        ))}
      </div>
      {config.themes.map((theme) => (
        <button class="tm-row" aria-pressed={active.theme === theme.id} onClick={then(() => setTheme(theme.id))}>
          <span class="tm-sw">
            {(dark ? theme.dark : theme.light).map((color) => (
              <i style={{ background: color }} />
            ))}
          </span>
          <span class="nm">{theme.name}</span>
        </button>
      ))}
      <div class="tm-foot">A theme is one file that sets tokens. Layout never changes.</div>
    </div>
  );
}

const KEYS: [string[], string][] = [
  [["j", "k"], "Move down and up (arrows work too)"],
  [["↵"], "Open the folder or file"],
  [["⌫"], "Up one folder"],
  [["/"], "Filter this folder"],
  [[`${MOD} K`], "Find anything in the tree"],
  [["g"], "List or grid"],
  [["s"], "Change the sort"],
  [["t"], "Light or dark"],
  [["esc"], "Close the preview"],
  [["?"], "This list"],
];

export function Help() {
  return (
    <div class="scrim" onPointerDown={(event) => event.target === event.currentTarget && store.setHelp(false)}>
      <div class="help" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard</h2>
        <dl>
          {KEYS.map(([keys, what]) => (
            <>
              <dt>
                {keys.map((key) => (
                  <kbd>{key}</kbd>
                ))}
              </dt>
              <dd>{what}</dd>
            </>
          ))}
        </dl>
      </div>
    </div>
  );
}
