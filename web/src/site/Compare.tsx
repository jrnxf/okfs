import type { ReactNode } from "react";
import { better, note, rows, sources, tools } from "../comparison";

// The data marks code with backticks, as Markdown does.
function text(value: string): ReactNode[] {
  return value.split("`").map((part, at) => (at % 2 ? <code key={at}>{part}</code> : part));
}

const plain = (value: string) => value.replaceAll("`", "");

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
            okfs is for looking at a folder. It is read only unless writes are turned on, and it has no accounts, on purpose. Each cell about another tool is what its own documentation says.
          </p>
        </div>
      </div>
      <div className="overflow-x-auto ml-46 tablet:ml-0">
        <table className={"w-full min-w-[760px] border-collapse [font:400_14px/1.4_var(--mono)] [&_:is(th,td)]:border-b [&_:is(th,td)]:border-b-rule-faint [&_:is(th,td)]:pt-[9px] [&_:is(th,td)]:pr-3 [&_:is(th,td)]:pb-[9px] [&_:is(th,td)]:pl-0 [&_:is(th,td)]:text-left [&_:is(th,td)]:align-top [&_thead_th]:border-b-rule [&_thead_th]:font-[600] [&_tbody_th]:font-[400] [&_tbody_th]:text-ink-2 [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:bg-paper [&_td:nth-child(2)]:font-[600] [&_:is(td,thead_th):nth-child(2)]:px-2.5 [&_:is(td,thead_th):nth-child(3)]:pl-3"}>
          <caption className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]">
            {tools.map((tool) => plain(tool.name)).join(", ")}, side by side
          </caption>
          <thead>
            <tr>
              <th scope="col"></th>
              {tools.map((tool) => (
                <th scope="col" key={tool.name}>
                  {plain(tool.name)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">
                  {row.label}
                </th>
                {row.cells.map((cell, at) => (
                  <td key={at}>
                    {text(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2.5 [font:400_12px/1.5_var(--mono)] text-ink-2">
          {note}
        </p>
        <h3 className="mt-7 mb-0 [font:600_14px/1.4_var(--mono)]">
          Where another tool is the better choice
        </h3>
        <ul className="mt-2 mb-0 max-w-[78ch] list-none p-0 [font:400_14px/1.5_var(--mono)] [&_li]:border-b [&_li]:border-b-rule-faint [&_li]:py-[7px]">
          {better.map((item) => (
            <li key={item}>
              {text(item)}
            </li>
          ))}
        </ul>
        <p className="mt-2.5 mb-0 [font:400_12px/1.5_var(--mono)] text-ink-2">
          Sources:{" "}
          {sources.flatMap((source) => source.links.map((link, at) => ({ link, label: plain(source.name) + (at ? ` (${link.split("/").pop()})` : "") }))).map(({ link, label }, at) => (
            <span key={link}>
              {at ? ", " : ""}
              <a className="underline" href={link}>
                {label}
              </a>
            </span>
          ))}
          .
        </p>
      </div>
    </section>
  );
}
