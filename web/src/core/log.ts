// Stand-in for YanniLogging's os.Logger categories: a no-op unless enabled.
export const log = {
  enabled: false,
  debug(category: string, ...args: unknown[]): void {
    if (this.enabled) console.debug(`[${category}]`, ...args);
  },
  error(category: string, ...args: unknown[]): void {
    console.error(`[${category}]`, ...args);
  },
};
