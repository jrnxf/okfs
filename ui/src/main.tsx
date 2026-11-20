import { render } from "preact";
import { AddressAdapter } from "./address";
import { App } from "./app";
import { config } from "./config";
import { follow } from "./live";
import { store } from "./store";

document.body.classList.toggle("has-note", config.header !== null);
render(
  <AddressAdapter>
    <App />
  </AddressAdapter>,
  document.body,
);
void store.start();
follow();
