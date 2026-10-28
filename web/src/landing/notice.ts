const listeners = new Set<(text: string) => void>();
export const onToast = (fn: (text: string) => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const toast = (text: string) => listeners.forEach((fn) => fn(text));
