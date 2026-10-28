import { useEffect, useRef, type RefObject } from "react";

/** Runs `fn` once when the element comes into view, once `ready`. */
export function useLazy(ref: RefObject<Element | null>, ready: boolean, fn: () => void) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!ready || !ref.current) return;
    const io = new IntersectionObserver(
      ([e], obs) => {
        if (!e!.isIntersecting) return;
        obs.disconnect();
        latest.current();
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [ready, ref]);
}
