export function Footer() {
  return (
    <footer className="mt-[90px] border-t-3 [border-top-style:double] border-t-rule">
      <div className="mx-auto max-w-[1220px] px-8 phone:px-4 flex flex-wrap items-center gap-x-6.5 gap-y-3 pt-5.5 pb-10 [font:400_13px/1.5_var(--mono)]">
        <svg className="logo w-[100px]" viewBox="0 0 2647 850" role="img" aria-label="okfs">
          <use href="#okfs-logo" width="2647" height="850" />
        </svg>
        <a href="/demo/">
          live demo
        </a>
        <a href="https://github.com/jrnxf/okfs">
          source
        </a>
        <a href="https://github.com/jrnxf/okfs/releases">
          releases
        </a>
        <span className="ml-auto text-ink-2">
          Set in Fraunces and IBM Plex Mono, under the SIL Open Font License.
        </span>
      </div>
    </footer>
  );
}
