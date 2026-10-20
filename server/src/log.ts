// One-line logs for the add-on log panel. Never log tokens, codes, announcement text or anything anyone said.
const at = () => new Date().toISOString();
export const log = {
  info: (m: string) => console.log(`${at()} INFO ${m}`),
  warn: (m: string) => console.warn(`${at()} WARN ${m}`),
};
