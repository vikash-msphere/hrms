// Cached `Intl` formatters.
//
// CONSTRUCTING an Intl formatter resolves locale data and costs roughly 11 microseconds; FORMATTING with one
// that already exists costs roughly 0.2. Every formatter in the app was built at its call site, inside the
// render path - `formatMoney` made a fresh `Intl.NumberFormat` per cell, and `formatDate` went through
// `toLocaleDateString`, which builds one internally per call. A payroll table of 25 rows with 6 money columns
// spent ~1.7 ms per render inside the constructor alone, and re-ran it on every filter keystroke and sort.
// Measured on this checkout: 37x for the currency case, 32x for the date case, over 20k calls.
//
// The cache key is the locale plus the serialized options. Stringifying a five-key object is ~0.2 microseconds
// - two orders of magnitude below what it saves - so it is not worth a cleverer key. Key ORDER matters to
// `JSON.stringify`, so two call sites passing the same options in a different order get two entries; that is a
// duplicate, never a wrong answer.
//
// Formatters are stateless across `format()` calls, so sharing one between call sites is safe. The maps have
// no eviction, which is safe because of what the keys are made of - not, as it might look, because the
// options are source literals. Several call sites build options from VALUES: `formatMoney` from a currency
// code and a decimal count, and lib/attendance.ts from a timezone. So the key count is bounded by the
// distinct currencies, precisions and zones an org actually configures, which is a handful (the app is
// deliberately single-currency - see docs), and every one of them recurs on every render.
//
// It would stop being safe if a formatter were ever keyed on something per-ROW or free-text - a locale from
// user input, a currency read off an arbitrary record. Cache-key anything like that and this needs a bound.
//
// A caller that may pass an invalid option (an unknown currency code) still has to handle the throw - a
// failed construction is not cached, so it is retried and throws again. See `formatMoney` in lib/utils.ts.

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

const keyOf = (locale: string | undefined, opts: unknown) => `${locale ?? ""}|${JSON.stringify(opts)}`;

/** A shared `Intl.NumberFormat` for these options. Pass `undefined` for the browser's locale. */
export function numberFormat(locale: string | undefined, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = keyOf(locale, opts);
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    numberFormats.set(key, f);
  }
  return f;
}

/** A shared `Intl.DateTimeFormat` for these options. Pass `undefined` for the browser's locale. */
export function dateFormat(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = keyOf(locale, opts);
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    dateFormats.set(key, f);
  }
  return f;
}
