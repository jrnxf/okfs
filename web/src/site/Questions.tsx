export function Questions() {
  return (
    <section id="questions" className="scroll-mt-3 pt-16" aria-labelledby="questions-h">
      <div className="mb-6.5 grid grid-cols-[160px_1fr] gap-6 border-t-3 [border-top-style:double] border-t-rule pt-4.5 tablet:grid-cols-[1fr] tablet:gap-2">
        <div className="[font:500_12px/1.4_var(--mono)] tracking-[.1em] text-spot-ink uppercase">
          Questions
        </div>
        <div>
          <h2 className="m-0 font-serif font-[500] text-[length:clamp(30px,3.4vw,46px)] leading-[1.05] [font-variation-settings:'opsz'_96,'SOFT'_100,'WONK'_1] tracking-[-.01em]" id="questions-h">
            Questions
          </h2>
        </div>
      </div>
      <div className={"ml-46 tablet:ml-0 *:max-w-[70ch] *:border-b *:border-b-rule-faint *:py-4 [&_h3]:mt-0 [&_h3]:mb-1.5 [&_h3]:font-serif [&_h3]:font-[600] [&_h3]:text-[19px] [&_h3]:leading-[1.3] [&_h3]:[font-variation-settings:'opsz'_48,'SOFT'_100] [&_p]:m-0 [&_p]:text-[16.5px] [&_p]:text-ink-2"}>
        <div>
          <h3>
            How do I browse a folder in my browser?
          </h3>
          <p>
            {"Run "}
            <code>
              okfs
            </code>
            {" in it. It serves the folder at http://127.0.0.1:8080 and opens your browser on it."}
          </p>
        </div>
        <div>
          <h3>
            Is okfs an alternative to python -m http.server or miniserve?
          </h3>
          <p>
            Yes, for looking at files. It adds previews, a search of the whole tree and live updates, and stays read only unless you turn writes on.
          </p>
        </div>
        <div>
          <h3>
            How do I open files from my computer on my phone?
          </h3>
          <p>
            <code>
              okfs --bind 0.0.0.0 --qr
            </code>
            {" prints a QR code with a secret link. Scan it on a phone on the same network."}
          </p>
        </div>
        <div>
          <h3>
            Can visitors upload, edit or delete files?
          </h3>
          <p>
            {"Only when you turn it on. "}
            <code>
              --allow-upload
            </code>
            {" adds files and folders and never replaces one, "}
            <code>
              --allow-edit
            </code>
            {" changes text files in place, and "}
            <code>
              --allow-delete
            </code>
            {" deletes. Each is off by default."}
          </p>
        </div>
        <div>
          <h3>
            Does okfs need Docker, a database or an account?
          </h3>
          <p>
            No. It is one binary with the page inside it.
          </p>
        </div>
        <div>
          <h3>
            Does it run on Windows?
          </h3>
          <p>
            Not yet. It runs on Linux and macOS.
          </p>
        </div>
      </div>
    </section>
  );
}
