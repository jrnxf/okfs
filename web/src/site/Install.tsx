import { useState } from "react";
import { CopyButton } from "../shared/copy";

export function Install() {
  // Every way's commands are in the page, so a reader without scripts sees them too: a tick shows one.
  const [way, setWay] = useState("brew");
  return (
    <section id="install" className="scroll-mt-3 pt-16" aria-labelledby="install-h">
      <div className="mb-6.5 grid grid-cols-[160px_1fr] gap-6 border-t-3 [border-top-style:double] border-t-rule pt-4.5 tablet:grid-cols-[1fr] tablet:gap-2">
        <div className="[font:500_12px/1.4_var(--mono)] tracking-[.1em] text-spot-ink uppercase">
          Order form
        </div>
        <div>
          <h2 className="m-0 font-serif font-[500] text-[length:clamp(30px,3.4vw,46px)] leading-[1.05] [font-variation-settings:'opsz'_96,'SOFT'_100,'WONK'_1] tracking-[-.01em]" id="install-h">
            Install
          </h2>
        </div>
      </div>
      <div className="relative border-2 border-dashed border-ink bg-paper-2 px-7 py-6.5 phone:px-4 phone:py-5.5 ml-46 tablet:ml-0">
        <span className="absolute -top-3.5 left-5.5 bg-paper px-2 [font:400_18px/1_var(--mono)]" aria-hidden="true">
          ✂
        </span>
        <h3 className="mt-0 mb-1 font-serif font-[600] text-[26px] leading-[1.1] [font-variation-settings:'opsz'_72,'SOFT'_100,'WONK'_1]">
          Clip and paste into a terminal.
        </h3>
        <p className="mb-4.5 [font:400_13px/1.4_var(--mono)] text-ink-2">
          No postage. Tick one.
        </p>
        <fieldset className="m-0 mb-4 flex flex-wrap gap-x-5.5 gap-y-2 border-0 p-0 [font:400_15px/1.3_var(--mono)]">
          <legend className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]">
            How to install
          </legend>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input className="m-0 grid size-[18px] appearance-none place-items-center border-[1.5px] border-ink checked:after:[font:600_14px/1_var(--mono)] checked:after:text-spot checked:after:content-['✕']" type="radio" name="way" value="brew" checked={way === "brew"} onChange={() => setWay("brew")} />
            brew
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input className="m-0 grid size-[18px] appearance-none place-items-center border-[1.5px] border-ink checked:after:[font:600_14px/1_var(--mono)] checked:after:text-spot checked:after:content-['✕']" type="radio" name="way" value="nix" checked={way === "nix"} onChange={() => setWay("nix")} />
            nix
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input className="m-0 grid size-[18px] appearance-none place-items-center border-[1.5px] border-ink checked:after:[font:600_14px/1_var(--mono)] checked:after:text-spot checked:after:content-['✕']" type="radio" name="way" value="release" checked={way === "release"} onChange={() => setWay("release")} />
            release archive
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input className="m-0 grid size-[18px] appearance-none place-items-center border-[1.5px] border-ink checked:after:[font:600_14px/1_var(--mono)] checked:after:text-spot checked:after:content-['✕']" type="radio" name="way" value="cargo" checked={way === "cargo"} onChange={() => setWay("cargo")} />
            cargo
          </label>
        </fieldset>
        <div className="way" data-way="brew" hidden={way !== "brew"}>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              brew install jrnxf/tap/okfs
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"brew install jrnxf/tap/okfs"} />
          </div>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              okfs ~/photos
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"okfs ~/photos"} />
          </div>
          <p className="mt-3 [font:400_13px/1.5_var(--mono)] text-ink-2">
            On a Mac or Linux. brew upgrade okfs updates it.
          </p>
        </div>
        <div className="way" data-way="nix" hidden={way !== "nix"}>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              nix run github:jrnxf/okfs -- ~/photos
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"nix run github:jrnxf/okfs -- ~/photos"} />
          </div>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              nix profile install github:jrnxf/okfs
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"nix profile install github:jrnxf/okfs"} />
          </div>
          <p className="mt-3 [font:400_13px/1.5_var(--mono)] text-ink-2">
            The first line runs it once in ~/photos. The second puts it on your PATH; nix profile upgrade okfs updates it.
          </p>
        </div>
        <div className="way" data-way="release" hidden={way !== "release"}>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              tag=$(gh release list --repo jrnxf/okfs --limit 1 --json tagName --jq &apos;.[0].tagName&apos;)
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"tag=$(gh release list --repo jrnxf/okfs --limit 1 --json tagName --jq '.[0].tagName')"} />
          </div>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              gh release download &quot;$tag&quot; --repo jrnxf/okfs --pattern &apos;*-aarch64-apple-darwin.tar.gz*&apos;
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"gh release download \"$tag\" --repo jrnxf/okfs --pattern '*-aarch64-apple-darwin.tar.gz*'"} />
          </div>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              tar -xzf okfs-*-aarch64-apple-darwin.tar.gz
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"tar -xzf okfs-*-aarch64-apple-darwin.tar.gz"} />
          </div>
          <p className="mt-3 [font:400_13px/1.5_var(--mono)] text-ink-2">
            That is a Mac with Apple silicon; the binary is okfs in the folder the archive makes. For an Intel Mac ask for x86_64-apple-darwin, for Linux x86_64- or aarch64-unknown-linux-musl. Each archive holds completions and a man page. The first release, v0.1.0-pre.1, is on its way.
          </p>
        </div>
        <div className="way" data-way="cargo" hidden={way !== "cargo"}>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              cargo install --git https://github.com/jrnxf/okfs
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"cargo install --git https://github.com/jrnxf/okfs"} />
          </div>
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-b-ink py-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap bg-transparent p-0 text-[16px] phone:text-[13px]">
              okfs ~/photos
            </code>
            <CopyButton className="flex-none border border-ink bg-paper px-2.25 py-1.5 [font:500_12px/1_var(--mono)]" text={"okfs ~/photos"} />
          </div>
          <p className="mt-3 [font:400_13px/1.5_var(--mono)] text-ink-2">
            It needs a Rust toolchain and bun, which builds the page.
          </p>
        </div>
      </div>
    </section>
  );
}
