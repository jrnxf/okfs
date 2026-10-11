// Choices remembered per browser. Storage can be blocked, so every call is allowed to fail.

export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`okfs.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`okfs.${key}`, value);
    } catch {
      // Nothing to do: the choice lasts for this visit only.
    }
  },
};
