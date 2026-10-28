import { CopyButton } from "../shared/copy";

export function Install() {
  return (
    <section className="border-t border-t-rule" id="install">
      <div className="mx-auto max-w-[1440px] px-10 under-860:px-4">
        <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,440px)] items-baseline gap-x-10 pt-24 pb-10 under-1000:grid-cols-[minmax(0,1fr)] under-1000:gap-y-3.5 under-860:pt-16 under-860:pb-7">
          <span className="[font:500_13px/1_var(--mono)] text-ink-3">
            07 Install
          </span>
          <h2 className="m-0 font-sans font-[760] text-[length:clamp(34px,4.4vw,68px)] leading-[.98] font-stretch-[112%] tracking-[-.03em] text-balance *:not-italic *:text-spot">
            Run it in a folder.
          </h2>
          <div>
            <p className="m-0 text-pretty text-ink-2">
              On a Mac or Linux, Homebrew installs it. With nix, run it without installing anything. On x86-64 Linux, each release has the binary on its own. From a checkout, cargo builds it.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] border-t border-t-ink *:flex *:items-center *:gap-4 *:border-b *:border-b-rule *:py-3.5 *:[font:15px/1.4_var(--mono)]">
          <div>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] under-760:whitespace-normal under-760:wrap-anywhere">
              brew install jrnxf/tap/okfs
            </code>
            <CopyButton className="flex-none cursor-pointer border-0 bg-ink px-2 py-1.25 [font:600_12px/1_var(--sans)] text-bg hover:bg-spot hover:text-spot-ink" text="brew install jrnxf/tap/okfs" />
          </div>
          <div>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] under-760:whitespace-normal under-760:wrap-anywhere">
              nix run github:jrnxf/okfs -- ~/photos
            </code>
            <CopyButton className="flex-none cursor-pointer border-0 bg-ink px-2 py-1.25 [font:600_12px/1_var(--sans)] text-bg hover:bg-spot hover:text-spot-ink" text="nix run github:jrnxf/okfs -- ~/photos" />
          </div>
          <div>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] under-760:whitespace-normal under-760:wrap-anywhere">
              nix profile install github:jrnxf/okfs
            </code>
            <CopyButton className="flex-none cursor-pointer border-0 bg-ink px-2 py-1.25 [font:600_12px/1_var(--sans)] text-bg hover:bg-spot hover:text-spot-ink" text="nix profile install github:jrnxf/okfs" />
          </div>
          <div>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] under-760:whitespace-normal under-760:wrap-anywhere">
              gh release download --repo jrnxf/okfs --pattern &apos;okfs-x86_64-unknown-linux-gnu*&apos;
            </code>
            <CopyButton className="flex-none cursor-pointer border-0 bg-ink px-2 py-1.25 [font:600_12px/1_var(--sans)] text-bg hover:bg-spot hover:text-spot-ink" text="gh release download --repo jrnxf/okfs --pattern 'okfs-x86_64-unknown-linux-gnu*'" />
          </div>
          <div>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] under-760:whitespace-normal under-760:wrap-anywhere">
              {"cargo install --path . "}
              <span className="text-ink-3">
                # in a checkout, with bun on the PATH
              </span>
            </code>
            <CopyButton className="flex-none cursor-pointer border-0 bg-ink px-2 py-1.25 [font:600_12px/1_var(--sans)] text-bg hover:bg-spot hover:text-spot-ink" text="cargo install --path ." />
          </div>
        </div>
        <div className="mt-5.5 mb-24 flex flex-wrap gap-x-7 gap-y-2 [font:13px/1.5_var(--mono)] text-ink-3 under-860:mb-16">
          <span>
            Linux and macOS
          </span>
          <span>
            Read only by default
          </span>
          <span>
            MIT licensed
          </span>
        </div>
        <div className="-mt-16 mb-24 flex flex-wrap gap-x-7 gap-y-3 [font:15px/1.5_var(--mono)] under-860:-mt-10 under-860:mb-16 *:text-ink *:decoration-spot *:underline-offset-5">
          <a href="https://github.com/jrnxf/okfs">
            Source on GitHub
          </a>
          <a href="https://github.com/jrnxf/okfs#use">
            How to use it
          </a>
        </div>
      </div>
    </section>
  );
}
