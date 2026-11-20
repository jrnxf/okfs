import { NuqsAdapter, enableHistorySync } from "nuqs/adapters/react";
import { render } from "preact";
import { App } from "./app";
import { config } from "./config";
import { follow } from "./live";
import { store } from "./store";

// The store moves the address itself, with the History API: the hooks of view.ts hear each move.
enableHistorySync();
document.body.classList.toggle("has-note", config.header !== null);
render(
  <NuqsAdapter>
    <App />
  </NuqsAdapter>,
  document.body,
);
void store.start();
follow();
