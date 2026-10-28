import { useEffect, useState } from "react";
import type { BackendStatus } from "../backend";
import type { Demo } from "../runtime";
import { loadDemo } from "./demo";

/** okfs's runtime, once it is up, and what it says as it reads the folder. */
export function useOkfs() {
  const [demo, setDemo] = useState<Demo>();
  const [status, setStatus] = useState<BackendStatus>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    loadDemo().then(
      (ready) => {
        setDemo(ready);
        ready.backend.onStatus((s) => setStatus({ ...s }));
      },
      (error) => {
        console.error(error);
        setFailed(true);
      },
    );
  }, []);
  return { demo, status, failed };
}
