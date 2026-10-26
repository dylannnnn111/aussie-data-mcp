// Ids the model passes in end up in request URLs, so each one is checked against what a real id looks like
// before any request is made (OWASP LLM05, improper output handling). The hosts are fixed either way.
export const ID_PATTERNS = {
  rbaTable: { re: /^[a-zA-Z]\d{1,2}(\.\d{1,2})?$/, hint: "RBA table ids look like f6, f11.1 or d1" },
  absDataflow: { re: /^[A-Za-z0-9_@]+(,[A-Za-z0-9_@]+(,\d+(\.\d+){0,2})?)?$/, hint: "ABS dataflow ids look like CPI, BA_GCCSA or ABS,CPI,1.1.0" },
  absKey: { re: /^[A-Za-z0-9_+.-]{0,300}$/, hint: "SDMX keys use codes joined by '.' and '+', e.g. 3.10001.10.50.M" },
  absCode: { re: /^[A-Za-z0-9_]{1,40}$/, hint: "ABS codes are letters, digits and underscores, e.g. 10001" },
} as const;

export function checkId(kind: keyof typeof ID_PATTERNS, value: string): string {
  const { re, hint } = ID_PATTERNS[kind];
  if (!re.test(value)) throw new Error(`"${value.slice(0, 60)}" isn't a valid id. ${hint}.`);
  return value;
}
