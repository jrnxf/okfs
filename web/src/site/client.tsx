import { hydrateRoot } from "react-dom/client";
import { Page } from "./Page";

hydrateRoot(document.getElementById("root")!, <Page />);
