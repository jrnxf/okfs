import { Binary } from "./Binary";
import { Footer } from "./Footer";
import { How } from "./How";
import { Install } from "./Install";
import { Keys } from "./Keys";
import { Previews } from "./Previews";
import { Search } from "./Search";
import { Sprite } from "./Sprite";
import { Themes } from "./Themes";
import { Toast } from "./Toast";
import { Top } from "./Top";

export function Page() {
  return (
    <>
      <Sprite />
      <Top />
      <Search />
      <Keys />
      <Previews />
      <Themes />
      <Binary />
      <How />
      <Install />
      <Footer />
      <Toast />
    </>
  );
}
