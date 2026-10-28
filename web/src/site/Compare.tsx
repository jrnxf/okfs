export function Compare() {
  return (
    <section id="compare" className="scroll-mt-3 pt-16" aria-labelledby="compare-h">
      <div className="mb-6.5 grid grid-cols-[160px_1fr] gap-6 border-t-3 [border-top-style:double] border-t-rule pt-4.5 tablet:grid-cols-[1fr] tablet:gap-2">
        <div className="[font:500_12px/1.4_var(--mono)] tracking-[.1em] text-spot-ink uppercase">
          Comparison
        </div>
        <div>
          <h2 className="m-0 font-serif font-[500] text-[length:clamp(30px,3.4vw,46px)] leading-[1.05] [font-variation-settings:'opsz'_96,'SOFT'_100,'WONK'_1] tracking-[-.01em]" id="compare-h">
            How okfs compares
          </h2>
          <p className="mt-2.5 mb-0 max-w-[62ch] text-ink-2">
            okfs is for looking at a folder. It is read only unless writes are turned on, and it has no accounts, on purpose: for uploads of very large files that resume, use copyparty; for a file manager with users, File Browser Quantum.
          </p>
        </div>
      </div>
      <div className="overflow-x-auto ml-46 tablet:ml-0">
        <table className={"w-full min-w-[760px] border-collapse [font:400_14px/1.4_var(--mono)] [&_:is(th,td)]:border-b [&_:is(th,td)]:border-b-rule-faint [&_:is(th,td)]:pt-[9px] [&_:is(th,td)]:pr-3 [&_:is(th,td)]:pb-[9px] [&_:is(th,td)]:pl-0 [&_:is(th,td)]:text-left [&_:is(th,td)]:align-top [&_thead_th]:border-b-rule [&_thead_th]:font-[600] [&_tbody_th]:font-[400] [&_tbody_th]:text-ink-2 [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:bg-paper [&_td:nth-child(2)]:font-[600] [&_:is(td,thead_th):nth-child(2)]:px-2.5 [&_:is(td,thead_th):nth-child(3)]:pl-3 [&_td.win]:bg-win [&_td.ahead]:pl-[17px] [&_td.ahead]:-indent-[17px] [&_td.ahead]:before:mr-2 [&_td.ahead]:before:inline-block [&_td.ahead]:before:size-[9px] [&_td.ahead]:before:border-[1.5px] [&_td.ahead]:before:border-ink-2 [&_td.ahead]:before:align-[1px] [&_td.ahead]:before:content-['']"}>
          <caption className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]">
            okfs beside python -m http.server, miniserve, dufs and copyparty
          </caption>
          <thead>
            <tr>
              <th scope="col"></th>
              <th scope="col">
                okfs
              </th>
              <th scope="col">
                python -m http.server
              </th>
              <th scope="col">
                miniserve
              </th>
              <th scope="col">
                dufs
              </th>
              <th scope="col">
                copyparty
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                Default address
              </th>
              <td className="win">
                loopback only
              </td>
              <td>
                all interfaces
              </td>
              <td>
                all interfaces
              </td>
              <td>
                all interfaces
              </td>
              <td>
                all interfaces
              </td>
            </tr>
            <tr>
              <th scope="row">
                Beyond loopback
              </th>
              <td>
                secret link
              </td>
              <td>
                none
              </td>
              <td className="ahead">
                basic auth, optional
              </td>
              <td className="ahead">
                basic or digest auth, optional
              </td>
              <td className="ahead">
                accounts
              </td>
            </tr>
            <tr>
              <th scope="row">
                Writes
              </th>
              <td className="win">
                none unless turned on: upload, edit and delete, each behind a flag
              </td>
              <td>
                none
              </td>
              <td>
                upload, optional
              </td>
              <td>
                upload, edit, move and delete, each optional
              </td>
              <td>
                upload, per account
              </td>
            </tr>
            <tr>
              <th scope="row">
                Previews
              </th>
              <td className="win">
                images, video, audio, PDF, Markdown, code, CSV, JSON, zip, HTML
              </td>
              <td>
                none
              </td>
              <td>
                none
              </td>
              <td>
                none
              </td>
              <td>
                thumbnails, audio spectrograms
              </td>
            </tr>
            <tr>
              <th scope="row">
                Search of the whole tree
              </th>
              <td className="win">
                instant, in memory
              </td>
              <td>
                none
              </td>
              <td>
                none
              </td>
              <td>
                yes
              </td>
              <td>
                yes, indexed
              </td>
            </tr>
            <tr>
              <th scope="row">
                Live updates
              </th>
              <td className="win">
                yes
              </td>
              <td>
                none
              </td>
              <td>
                none
              </td>
              <td>
                none
              </td>
              <td>
                not checked
              </td>
            </tr>
            <tr>
              <th scope="row">
                TLS
              </th>
              <td className="win">
                yes, optional
              </td>
              <td>
                since Python 3.14
              </td>
              <td>
                yes
              </td>
              <td>
                yes
              </td>
              <td>
                yes
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2.5 mb-0 flex flex-wrap items-center gap-x-[18px] gap-y-1 [font:400_12px/1.4_var(--mono)] text-ink-2">
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-2.5 w-3.5 border border-rule-faint bg-win"></span>
            no tool is ahead of okfs
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="inline-block size-[9px] border-[1.5px] border-ink-2"></span>
            this tool is ahead of okfs
          </span>
        </p>
        <p className="mt-2.5 [font:400_12px/1.5_var(--mono)] text-ink-2">
          This is how each tool read on 2026-10-21, from its documentation. Check the project you are comparing before you rely on a cell.
        </p>
      </div>
    </section>
  );
}
