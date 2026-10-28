import { getScheme, setScheme } from "./scheme";

export function Header() {
  return (
    <header className="border-b border-b-rule">
      <div className="mx-auto max-w-[1220px] px-8 phone:px-4 flex items-center gap-5.5 py-3 [font:400_13px/1_var(--mono)] phone:gap-2.5">
        <a className="block no-underline" href="/" aria-label="okfs">
          <svg className="logo w-[100px]" viewBox="0 0 2647 850" role="img" aria-label="okfs">
            <use href="#okfs-logo" width="2647" height="850" />
          </svg>
        </a>
        <nav className="ml-auto flex items-center gap-5.5 phone:gap-3" aria-label="Sections">
          <a className="no-underline hover:text-spot-ink phone:hidden" href="#measured">
            measured
          </a>
          <a className="no-underline hover:text-spot-ink phone:hidden" href="#finishes">
            finishes
          </a>
          <a className="no-underline hover:text-spot-ink phone:hidden" href="#compare">
            compare
          </a>
          <a className="no-underline hover:text-spot-ink" href="#install">
            install
          </a>
          <a className="no-underline hover:text-spot-ink phone:hidden" href="https://github.com/jrnxf/okfs">
            github
          </a>
          <button onClick={() => setScheme(getScheme() === "dark" ? "light" : "dark")} className="border border-rule bg-transparent px-2.25 py-1.25 [font:400_12px/1_var(--mono)] whitespace-nowrap" type="button" id="theme" aria-label="day / night: switch between dark and light">
            day / night
          </button>
        </nav>
      </div>
    </header>
  );
}
