// The lint gate. Wired into `npm run verify`, so it runs on precommit and in CI alongside spectral, tsc and
// vitest.
//
// WHY IT EXISTS. There was no linter in the project at all - no dependency, no config, no script - while
// `web/src/pages` carried around forty `// eslint-disable-line react-hooks/exhaustive-deps` comments. Those
// suppressions read as decisions somebody took, and every one of them was inert: nothing was checking the rule
// they silence, so a deliberate suppression and a stale-closure bug looked exactly alike. The hooks rules below
// are what those comments have been assuming all along.
//
// DELIBERATELY NARROW. This is not a style gate - `tsc --noEmit` already covers types, and the codebase has a
// house style no shared preset agrees with. Every rule here catches a class of BUG rather than a preference,
// and the set is sized so that it passes today without a wave of new suppressions: a gate people have to
// silence to get work done stops being read.
//
// NO TYPE-AWARE RULES, and that is a measured decision rather than an oversight. `no-floating-promises` and
// `no-misused-promises` are the two most valuable rules eslint has for a codebase that is asynchronous end to
// end, and both need a full type program. Turned on across this repo (200k lines, four tsconfigs, plus the
// 33k-line generated `src/http/openapi.d.ts` that the program pulls in whether or not it is linted), the run
// exhausts an 8 GB V8 heap and aborts - so it is not a gate, it is a coin toss. Revisit if the generated
// declarations are ever trimmed or the lint is split per-project; until then `tsc`'s own strictness plus the
// `void x()` convention already in the code carry that weight.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // Build output, dependencies, generated declarations, and test/scratch artifacts.
    ignores: [
      "node_modules/**",
      "web/dist/**",
      ".wrangler/**",
      // Agent worktrees: whole copies of this repo living inside it. Linting them reports every finding once
      // per copy, against files that are not the ones anybody is editing.
      ".claude/**",
      ".repowise/**",
      ".tokensave/**",
      "test-results*/**",
      "playwright-report/**",
      "blob-report/**",
      "src/http/openapi.d.ts",
      "src/db/migrations/**",
      "misc/**",
      "aep/**",
      "web/public/**",
      // Vendored pdf.js wasm fallbacks - minified third-party bundles, already git-ignored. Between them they
      // account for 97% of every finding this config produces, none of it about code anyone here wrote.
      "web/src/web/dummy-non-existing-folder/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // ---- Off: covered elsewhere, or at odds with how this codebase is written --------------------------
      // `tsc --noEmit` already refuses an unused local. The lint copy differs only by also flagging unused
      // catch bindings and parameters, which are used here to document a signature that must be matched.
      "@typescript-eslint/no-unused-vars": "off",
      // `any` appears where drizzle's builder types cannot be expressed (the D1 batch helpers), narrowed by
      // hand at every call site. `noImplicitAny` in tsconfig is the gate that matters.
      "@typescript-eslint/no-explicit-any": "off",
      // `!` is used deliberately after a bounds check the type system cannot follow - the codec's byte walks,
      // the payroll row lookups. Each is load-bearing and reviewed.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      // Two `@ts-expect-error`-free casts through `unknown` are how the batch envelope talks to D1's types.
      "@typescript-eslint/no-unnecessary-type-constraint": "off",
      // `cond && doThing()` as a statement is the house idiom and reads better than the `if` it expands to.
      // Ternaries used for effect are the same shape. A bare expression that is NEITHER is still an error,
      // which is the case worth catching (a call missing its parentheses).
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      // Wants `{ cause: e }` on every rethrow. A convention rather than a bug rule, and the rethrows it flags
      // are UI-level - a caught API error re-thrown so a dialog stays open - where the original is already in
      // the message and nothing reads `.cause`. Adding it would be 14 mechanical edits for no reader.
      "preserve-caught-error": "off",
      // Fights the defensive initializer before a try/catch: `let x = <fallback>; try { x = parse() } catch {}`.
      // The initializer IS dead when the catch also assigns, and it is still the right way to write it - the
      // declaration says what the value is when nothing works. Used throughout the services and the PDF code.
      "no-useless-assignment": "off",
      // The barcode parser matches the GS1 FNC1 group separator (\x1d) on purpose (web/src/lib/assetTags.ts).
      // A control character in a regex is a mistake in prose-handling code and the whole point in this one.
      "no-control-regex": "off",
      // Collides head-on with the drift tests, which quote SOURCE containing `${...}` as string fixtures
      // (test/moneyDrift.test.ts asserts on `"sql`${schema.loans.repaid} + ${amount}`"`). Every current report
      // is one of those, so the rule can only cost attention here.
      "no-template-curly-in-string": "off",

      // ---- On: the bug-catching set -----------------------------------------------------------------------
      // `==` against null is the intended "null or undefined" test and is used that way throughout.
      eqeqeq: ["error", "always", { null: "ignore" }],
      // A comparison or default that can only ever go one way - the shape a guard takes when it stops guarding.
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      // Two cases in one switch arm silently take the first; a duplicate object key silently takes the last.
      "no-duplicate-case": "error",
      "no-dupe-else-if": "error",
      // An `async` executor's rejection is swallowed by the Promise constructor rather than rejecting it.
      "no-async-promise-executor": "error",
      // `await` inside a loop body is how a fan-out becomes N round-trips; flagged as a warning because the
      // sequential form is sometimes exactly what a guarded write wants (see the carry-forward retry in cron).
      "require-atomic-updates": "off",
    },
  },
  // The SPA. The hooks rules are the reason this file exists.
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // ERROR. A conditionally-called hook is a crash, not a smell: the render after the condition flips
      // throws "Rendered more hooks than during the previous render" and takes the page with it. Enabling this
      // found six live instances - `usePermission(a) || usePermission(b)` short-circuiting past the second
      // hook in three pages, a `useElapsedMinutes` below an early return on the dashboard clock, and a
      // `useContext` inside a ternary in Field - every one of them reachable, because the values they branch
      // on (capabilities, settings, a prop) all arrive after the first paint. The tree is clean; it stays that
      // way.
      "react-hooks/rules-of-hooks": "error",
      // WARNING, WITH A CEILING. There are 69 of these, and they are one shape: a helper defined in the
      // component body (`isOwn`, `cycleOf`, `load`) used inside a `useMemo` whose deps list the DATA the
      // helper reads rather than the helper itself. Adding the helper as written defeats the memo - a new
      // function identity every render - so each one is really "wrap this in useCallback", which is 69
      // behaviour-changing edits across the SPA's busiest pages for no defect anybody has seen. That is not a
      // change to make in the same pass that turns the linter on.
      //
      // So it is a ratchet rather than a wall: `npm run lint` passes `--max-warnings` at exactly today's
      // count, which means the existing debt is tolerated and ONE MORE fails the build. The number in
      // package.json comes down as these are paid off; it must never go up.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // `no-undef` is off for the whole tree, which is the standard advice for a TypeScript project and not a
  // weakening: `tsc --noEmit` already resolves every identifier against the lib and `@types` sets each
  // tsconfig declares, and it knows which globals exist in a Worker isolate versus a browser tab. Left on,
  // this rule would need a hand-maintained globals list per environment that could only ever be a worse copy
  // of what the compiler already has, and would report `crypto`, `Response` or `indexedDB` as undefined.
  {
    rules: { "no-undef": "off" },
  },
);
