// Text put on the clipboard.

/**
 * Puts `text` on the clipboard. A page served over plain http, as okfs often is on a home network, has no clipboard
 * API, so a selected copy of the text stands in for it there. Fails when the browser refuses both.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const focused = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  // The keys go on working where they were.
  focused?.focus({ preventScroll: true });
  if (!copied) throw new Error("the browser did not copy");
}
