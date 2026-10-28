export function Footer() {
  return (
    <footer className="border-t border-t-rule">
      <div className={"mx-auto max-w-[1440px] px-10 under-860:px-4 flex flex-wrap justify-between gap-4.5 pt-10 pb-16 [font:14px/1.5_var(--mono)] text-ink-3 under-860:py-0 [&_a]:text-ink"}>
        <span>
          okfs, the ok file server, by jrnxf.
        </span>
        <span>
          {"Also by jrnxf: "}
          <a href="https://drip.jrnxf.co">
            drip
          </a>
          , cards from your Mac&apos;s notch.
        </span>
      </div>
    </footer>
  );
}
