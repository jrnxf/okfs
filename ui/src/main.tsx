import { render } from "preact";
import { App } from "./app";
import { config } from "./config";
import { store } from "./store";

document.body.classList.toggle("has-note", config.header !== null);
render(<App />, document.body);
void store.start();
