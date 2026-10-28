export function Box() {
  return (
    <section id="box" className="scroll-mt-3 pt-16" aria-labelledby="box-h">
      <div className="mb-6.5 grid grid-cols-[160px_1fr] gap-6 border-t-3 [border-top-style:double] border-t-rule pt-4.5 tablet:grid-cols-[1fr] tablet:gap-2">
        <div className="[font:500_12px/1.4_var(--mono)] tracking-[.1em] text-spot-ink uppercase">
          In the box
        </div>
        <div>
          <h2 className="m-0 font-serif font-[500] text-[length:clamp(30px,3.4vw,46px)] leading-[1.05] [font-variation-settings:'opsz'_96,'SOFT'_100,'WONK'_1] tracking-[-.01em]" id="box-h">
            What okfs does
          </h2>
        </div>
      </div>
      <dl className={"my-0 grid grid-cols-[repeat(2,1fr)] gap-x-10 gap-y-0 phone:grid-cols-[1fr] ml-46 tablet:ml-0 *:border-b *:border-b-rule-faint *:py-4 [&_dt]:mb-1 [&_dt]:font-serif [&_dt]:font-[600] [&_dt]:text-[19px] [&_dt]:leading-[1.25] [&_dt]:[font-variation-settings:'opsz'_48,'SOFT'_100] [&_dt_span]:mr-2.5 [&_dt_span]:align-[2px] [&_dt_span]:[font:500_12px/1_var(--mono)] [&_dt_span]:text-spot-ink [&_dd]:m-0 [&_dd]:text-[16.5px] [&_dd]:text-ink-2"}>
        <div>
          <dt>
            <span>
              01
            </span>
            Previews
          </dt>
          <dd>
            Pictures, video, sound, PDFs, Markdown, code, CSV, JSON, zip files and web pages, each shown as itself.
          </dd>
        </div>
        <div>
          <dt>
            <span>
              02
            </span>
            Search
          </dt>
          <dd>
            <code>
              Ctrl K
            </code>
            {" finds any name in the tree. The query lives in the address, so a shared link keeps it."}
          </dd>
        </div>
        <div>
          <dt>
            <span>
              03
            </span>
            Columns
          </dt>
          <dd>
            A folder under the cursor shows what is in it, and the columns slide as you go in and out.
          </dd>
        </div>
        <div>
          <dt>
            <span>
              04
            </span>
            Live
          </dt>
          <dd>
            A file added, removed or rewritten shows at once, without a reload.
          </dd>
        </div>
        <div>
          <dt>
            <span>
              05
            </span>
            Your phone
          </dt>
          <dd>
            <code>
              okfs --bind 0.0.0.0 --qr
            </code>
            {" prints a QR code for another device on the network."}
          </dd>
        </div>
        <div>
          <dt>
            <span>
              06
            </span>
            Self-contained
          </dt>
          <dd>
            The page is compiled into the binary. Nothing is fetched from another site.
          </dd>
        </div>
      </dl>
    </section>
  );
}
