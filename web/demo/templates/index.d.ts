export interface Options {
  /** Milliseconds to wait before the first retry. */
  delay?: number;
  /** How many times to try, the first one included. */
  attempts?: number;
  signal?: AbortSignal;
}

export declare function retry<T>(work: (attempt: number) => Promise<T>, options?: Options): Promise<T>;
export default retry;
