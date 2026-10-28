import { Box } from "./Box";
import { Compare } from "./Compare";
import { Finishes } from "./Finishes";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { Hero } from "./Hero";
import { Install } from "./Install";
import { Measured } from "./Measured";
import { Questions } from "./Questions";
import { Sprite } from "./Sprite";
import { Strip } from "./Strip";
import { useOkfs } from "./useOkfs";

/** The okfs site's front page: a catalogue page with okfs on the screen of a drawn computer. */
export function Page() {
  const { demo, status, failed } = useOkfs();
  const fmt = (n: number) => n.toLocaleString("en-US");
  const sub = status && !status.ready ? `reading the folder: ${fmt(status.seen)}` : "in this tab";
  return (
    <>
      <Sprite />
      <Header />
      <main className="mx-auto max-w-[1220px] px-8 phone:px-4">
        <Strip />
        <Hero demo={demo} failed={failed} sub={sub} />
        <Measured demo={demo} status={status} />
        <Finishes />
        <Box />
        <Compare />
        <Questions />
        <Install />
      </main>
      <Footer />
    </>
  );
}
