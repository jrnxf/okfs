// The address the hooks of view.ts read and write, through okfs's own `location` and `history`. In the demo the
// frame has no address of its own, and its build points both at a virtual one for every file here (see
// web/build.ts). nuqs's own adapters would write the frame's real address, which the browser refuses. The store
// moves the address itself and says so with `addressMoved`.

import {
  unstable_createAdapterProvider as createAdapterProvider,
  renderQueryString,
  type unstable_AdapterInterface as AdapterInterface,
} from "nuqs/adapters/custom";
import { useSyncExternalStore } from "preact/compat";

const listeners = new Set<() => void>();

function subscribe(changed: () => void): () => void {
  listeners.add(changed);
  addEventListener("popstate", changed);
  return () => {
    listeners.delete(changed);
    removeEventListener("popstate", changed);
  };
}

/** Tells the hooks that the address moved: the store calls it after each move of its own. */
export function addressMoved(): void {
  for (const changed of listeners) changed();
}

let last = { search: "", params: new URLSearchParams() };

/** The same object while the address is the same, as useSyncExternalStore needs. */
function current(): URLSearchParams {
  if (location.search !== last.search) last = { search: location.search, params: new URLSearchParams(location.search) };
  return last.params;
}

function useAddress(): AdapterInterface {
  return {
    searchParams: useSyncExternalStore(subscribe, current),
    pathname: location.pathname,
    getSearchParamsSnapshot: () => new URLSearchParams(location.search),
    updateUrl(search, { history: mode }) {
      const url = new URL(location.href);
      url.search = renderQueryString(search);
      if (mode === "push") history.pushState(history.state, "", url);
      else history.replaceState(history.state, "", url);
      addressMoved();
    },
  };
}

export const AddressAdapter = createAdapterProvider(useAddress);
