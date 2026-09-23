import * as React from "react";
import { Input } from "@/components/ui/input";
import { useOrg, currencyDecimals } from "@/lib/org";
import { cn, formatMoney } from "@/lib/utils";
import { numberFormat } from "@/lib/intl";

// Symbol for a currency, pulled out of the same formatter that renders amounts, so the prefix in the
// field and the figure in the table can never disagree about what "₹" means.
function symbolOf(currency: string): string {
  try {
    const parts = numberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 0 }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

// Short form of a big number in the reader's own convention: en-IN groups by lakh/crore, everywhere else
// by thousand/million. Only earns its place past a lakh, where the digit count is what people misread.
function compact(n: number, currency: string): string | null {
  if (!Number.isFinite(n) || Math.abs(n) < 100000) return null;
  const locale = currency === "INR" ? "en-IN" : undefined;
  try {
    return numberFormat(locale, { notation: "compact", maximumFractionDigits: 2 }).format(n);
  } catch {
    return null;
  }
}

// Amounts arrive pasted as often as typed - out of a spreadsheet cell, an email, a bank statement - and they
// arrive dressed: "₹1,20,000", "1 20 000", "12,000.50", a stray non-breaking space. `type="number"` rejects all
// of it silently, leaving an empty field and no clue why. So the field takes text and undresses the value:
// keep digits, one decimal point and a leading minus, drop the rest.
// Commas are grouping marks, not decimal points: this app writes amounts in en-IN/en-US style, where "1,20,000"
// means a lakh and twenty thousand. A dot is the decimal point, and only the first one counts.
// A leading bare "." keeps its place by seeding a zero: ".75" is three quarters, and dropping the point
// because nothing precedes it turned a pasted ".75" into "75" - the same digits, ten times the money, with
// nothing on screen to notice.
function sanitize(raw: string): string {
  let out = "";
  let dot = false;
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !dot) {
      out += out === "" || out === "-" ? "0." : ".";
      dot = true;
    } else if (ch === "-" && out === "") out += "-";
  }
  return out;
}

/**
 * The money field. A bare `<Input type="number">` is the wrong control for an amount: the currency is
 * implicit, six digits run together unseparated (250000 and 2500000 look alike at a glance, and a payroll
 * product cannot afford that confusion), the spinners invite a click that changes a salary by one rupee, and a
 * pasted "₹1,20,000" lands as nothing at all.
 *
 * So: the currency symbol sits in the field, spinners are gone, pasted formatting is stripped rather than
 * refused, and anything from a lakh up is echoed back grouped and in words underneath. The echo is a read of
 * what was typed, never a second input - the value stays the raw numeric string the caller owns, so form state
 * and validation are unchanged. It is announced politely so the echo reaches a screen reader too, which is the
 * one audience that gets nothing from seeing the grouping.
 */
export function MoneyInput({
  value,
  onChange,
  currency,
  className,
  readback = true,
  // Trailing note on the readback line ("per person", "per month") - context that would otherwise cost a hint.
  suffix,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  currency?: string;
  readback?: boolean;
  suffix?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const { org } = useOrg();
  const code = currency || org.default_currency || "INR";
  const symbol = React.useMemo(() => symbolOf(code), [code]);
  const n = Number(value);
  const short = compact(n, code);
  // `min`/`max` still mean what they mean on a number field; they just have to be enforced here now that the
  // control is text. Kept out of the DOM so a browser doesn't apply them to a string.
  //
  // AND THEY ARE ENFORCED, which the sentence above used to claim while nothing read them except the grouped
  // readback - a line that only renders from a thousand up. So a field declared `min={0}` accepted -250 (the
  // sanitizer keeps a leading minus by design) and said nothing at all, and the only thing standing between a
  // caller who trusted these props and a stored negative amount was whether its own form happened to re-check
  // the bound. Out of range is now a real invalid state at any magnitude: `aria-invalid` on the control, and
  // the reason in the readback, which renders for that reason alone when it otherwise would not.
  const { min, max, ...inputProps } = rest;
  const typed = value.trim() !== "" && Number.isFinite(n);
  const belowMin = typed && min != null && n < Number(min);
  const overMax = typed && max != null && n > Number(max);
  const outOfRange = belowMin || overMax;
  const show = readback && typed && (Math.abs(n) >= 1000 || outOfRange);

  return (
    <div className="space-y-1">
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-muted-foreground">{symbol}</span>
        <Input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(sanitize(e.target.value))}
          aria-describedby={show ? `${inputProps.id ?? "money"}-readback` : undefined}
          aria-invalid={outOfRange || inputProps["aria-invalid"] === true || undefined}
          className={cn("tabular-nums", symbol.length > 1 ? "pl-12" : "pl-7", className)}
          {...inputProps}
        />
      </div>
      {show && (
        <p id={`${inputProps.id ?? "money"}-readback`} aria-live="polite" className={cn("text-xs tabular-nums", outOfRange ? "text-destructive" : "text-muted-foreground")}>
          {formatMoney(n, code, currencyDecimals(code, org))}
          {short ? ` · ${short}` : ""}
          {suffix ? ` ${suffix}` : ""}
          {belowMin ? ` · below the ${formatMoney(Number(min), code, currencyDecimals(code, org))} minimum` : ""}
          {overMax ? ` · over the ${formatMoney(Number(max), code, currencyDecimals(code, org))} maximum` : ""}
        </p>
      )}
    </div>
  );
}

// Set explicitly, and matched by <Field> when it decides which controls its `<label for>` may point at: this
// is a labelable control (it forwards `id` to the input inside it), and without the name here every money
// field in the app - amount, principal, cap, rate - carried a label that named nothing. A minified build
// mangles Function.name, hence the assignment rather than relying on it. Same reason as ui/combobox.tsx.
MoneyInput.displayName = "MoneyInput";
