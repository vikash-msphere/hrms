// Pulls the whole unDraw illustration set into web/public/assets/illustrations/<category>/<slug>.svg
// and regenerates web/src/lib/illustrationPaths.ts. Source is the `undraw-svg` npm tarball (the entire
// set, MIT) plus a top-up straight from cdn.undraw.co for anything the package has not shipped yet, so
// nothing here scrapes undraw.co.
//
// Four transforms happen on the way in:
//  1. Recolour. unDraw art ships with a dark-navy structural palette that vanishes on a dark
//     background, and paints its accents with `currentColor`, which inherits nothing inside an
//     <img>-loaded SVG and so renders black. Because the app's theme is a user preference
//     (light/dark/system, see web/src/lib/theme.ts) a CSS media query inside the file would be wrong
//     whenever someone forces the theme against their OS, so every structural colour is flattened onto
//     the brand ramp (navy -> cyan, see BRAND below), whose tones read on either background.
//     Skin tones and greens are left alone.
//  2. Shrink. Comments, XML preamble and inter-tag whitespace go; ids stay, since clip-paths
//     reference them.
//  3. Categorise. unDraw publishes no taxonomy - the metadata carries only title, keywords (which are
//     just tokenised title words), dimensions and a hash - so CATEGORIES below derives one by matching
//     title+keywords against ordered term lists, first match winning. Anything unmatched lands in
//     `misc`, which is a real bucket and not a failure. Re-run after editing to reshuffle the folders.
//  4. Index. index.json (slug, dir, title, keywords, aspect) is written at the root for a picker to
//     fetch on demand - it is deliberately not bundled.
//
// Run: node scripts/fetchIllustrations.ts   (no src/ imports, so it needs no resolver hook; the file)
// Network: registry.npmjs.org, plus cdn.undraw.co for the top-up (skip it with --no-cdn).
// Palette change only: --recolour-only repaints the art already on disk, offline.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ordered; first match wins, so the specific category goes above the generic one. Terms are matched as
// substrings against "<title> <keywords>", which is why stems ("celebrat", "graduat") pull their whole
// family in.
const CATEGORIES: [string, string][] = [
  ["brands-logos", "algolia buffer gatsby flutter android google-docs basecamp hey-by stripe firebase mailchimp notion slack figma spotify netflix airbnb dua-lipa greek-freak react next-js nuxt laravel vue wordpress miro omega mello nakamoto marilyn"],
  ["ai-ml", "ai-agent ai-response ai-slop ai- large-language-model llm machine-learning virtual-assistant voice-assistant voice-control chatbot prompt neural visionary-technology"],
  ["search-empty", "search find explore magnif detective lost void empty nothing blank missing 404 unavailable discoverable no-data not-found just-browsing browsing"],
  ["errors-warnings", "error warning bug fix crash fail broken alert problem trouble maintenance downtime offline cancel access-denied denied throw-away"],
  ["security-privacy", "secur privacy password lock unlock authenticat protect safe shield encrypt firewall vpn fingerprint verified two-factor cyber hacker fraud gdpr confidential vault surveillance invite-only log-out login access-account user-account"],
  ["family-kids", "baby child kid fatherhood motherhood parent grandma grandpa family expecting doll toddler pregnan teddy-bear wedding"],
  ["celebration-recognition", "celebrat party congratul award trophy winner achieve success prize medal birthday anniversary cheers toast high-five feeling-proud accomplishment be-the-hero balloons pleasant-surprise super-thank-you mic-drop treasure"],
  ["seasons-holidays", "halloween easter christmas xmas santa autumn fall winter summer spring festiv holiday new-year new-decade year-20 election-day valentine thanksgiving carnival pumpkin women-day special-event"],
  ["food-drink", "food coffee breakfast lunch dinner eating pasta chef hamburger groceries beer wine cocoa beverage diet cook recipe kitchen restaurant cake pizza tea juice ice-cream tasting take-out"],
  ["sports-games", "basketball football soccer golf tennis gaming game sport race hiking biking bicycle cycling jogging fishing camping swim in-the-pool surf skate run marathon finish-line grand-slam gym workout fitness yoga pilates walk-stats track-and-field select-player select-character puzzle"],
  ["science-space", "astronaut astronomy space rocket planet-orbit hologram augmented-reality virtual-reality drone robot 3d-model science scientist experiment laboratory chemistry physics telescope unidentified-flying my-universe"],
  ["health-wellness", "health medical doctor nurse hospital patient medicine pill vaccine mental wellness therapy dentist care first-aid sick injured wash-hands"],
  ["finance-money", "money finance payment wallet salary invoice receipt bank credit budget savings tax revenue profit currency coin cash price billing pricing subscription refund transaction crypto bitcoin ethereum ether invest inflation insurance loan discount for-sale bull-market bear-market trading stocks term-sheet pay-online percentages projections jewelry"],
  ["charts-analytics", "chart graph analytic statistic stats metric dashboard report data kpi trend forecast pie bar insight measure cohort analysis analyze visualization segment percentage monthly-users users-per-minute split-testing observations"],
  ["goals-progress", "goal target objective milestone progress five-year-plan roadmap plan growing growth-curve going-up going-upwards going-downwards rising level-up stepping-up ambition right-direction missed-chances solution-mindset key-points prioritise steps process preparation"],
  ["tasks-checklists", "task todo to-do chore checklist check-box checking done complete completing completed confirm confirmation confirmed all-checked flagged for-review reviewed-docs approve accept clean-up organiz sort filing scrum-board pin-to-board collecting collection activity-tracker load-more"],
  ["calendar-time", "calendar schedule time clock deadline appointment reminder date agenda timeline alarm hourglass coming-soon a-whole-year day-off wait-in-line waiting late-at-night before-dawn morning ordinary-day everyday-life"],
  ["documents-files", "document file folder paper form contract certificate sign signature note notebook print scan archive clipboard resume online-cv short-bio portfolio upload download attach pdf letter diary annotation instruction-manual guidelines specs terms braille"],
  ["email-messaging", "email mail inbox message messenger messaging chat conversation comment reply respond sms envelope newsletter notification notify bell push calling call mention typing things-to-say just-saying wishes"],
  ["support-help", "faq contact-us ask-me-anything support help survey feedback ticket question answer quiz online-test multiple-choice testimonial review upvote voting vote opinion judge legal-counsel inspection usability-testing"],
  ["work-office", "work office desk job career employee coworker colleague hiring hire interview recruit workplace freelance remote workspace productive busy boss manager expert dev-focus focus in-the-zone public-speaking presenting pitching modern-professional services"],
  ["teamwork-meetings", "team collaborat collab meeting conference presentation brainstorm workshop group crowd partnership agree handshake together buddies connected connection neighbo join invite welcom nice-to-meet hello goodbye referral word-of-mouth"],
  ["code-development", "code coding develop program script debug software engineer version git terminal compil framework algorithm open-source firmware pull-request logic circuit static-assets"],
  ["cloud-devops", "cloud server host deploy devops infrastructure database backup sync docker network hosting storage electricity factory container-ship processing refresh loading speed-test fast"],
  ["ui-interactions", "button dropdown menu hamburger checkbox toggle switches slider swipe tab dialog modal form input insert enter drag click interaction select option choice choose radio placeholder dark-mode landscape-mode font typography contrast bento-grid element composition layout wireframe mockup prototyp settings adjust control-panel customization editable preference details icons zoom plug-in link-shortener user-flow segmentation"],
  ["design-creative", "design creative art draw paint sketch illustrat palette colour color brand logo studio craft animat sculpt pen-tool photo image picture polaroid gallery edit-photo capture abstract circles vintage"],
  ["media-entertainment", "music playlist listening press-play audio video reels movie cinema radio podcast dancing horror stream watching"],
  ["devices-tech", "mobile phone tablet laptop computer desktop device screen monitor keyboard smartwatch printer camera gadget calculator nfc internet-on-the-go online-everywhere online"],
  ["web-apps", "website web page browser landing responsive seo domain blog cms plugin signup onboarding setup wizard app launch relaunch ship-it under-construction build-mode building create creation marketing online-ad popular subscribe features-overview our-solution result"],
  ["social-media", "social media post feed follow like share influencer viral story livestream subscriber community forum discussion fans favourite favorite hooked tweetstorm dating"],
  ["shopping-ecommerce", "shop shopping cart store ecommerce order delivery deliveries product checkout package purchase warehouse retail coupon gift wishlist unboxing trying-on logistics towing"],
  ["writing-content", "writing write essay author copywriting content body-text text publishing editor manuscript news press"],
  ["education-learning", "education learn study student school teacher professor class course book read library exam graduat lecture tutorial knowledge research math grade bibliophile"],
  ["travel-transport", "travel trip vacation flight airport hotel journey navigat destination car bus train subway bike scooter drive commute road taxi truck yacht luggage adventure arrived directions map address on-the-move on-the-way joyride pedestrian passing-by swing hot-air-balloon i-can-fly through-the-desert japan"],
  ["places-nature", "city country-side farm cabin park landmark eiffel bridge amusement best-place right-places nature tree forest mountain beach ocean sea sun moon star sky weather rain snow wind climate environment eco recycle earth world flower blooming campfire outdoors outside wilderness touching-grass town suburb neighborhood walking quiet landscape"],
  ["home-lifestyle", "home house apartment room cleaning laundry moving furniture garden plant pet dog cat fish-bowl living modern-life staying-in movie-night fashion knocking-on-the-door opened door"],
  ["people-avatars", "avatar profile portrait selfie persona face bearded blonde curly hairstyle about-me people woman girl man boy modern-woman millennial super-woman superhero ninja unicorn"],
  ["emotions-people", "happy sad love romantic friend couple relax rest calm chilling stress anxious tired excited fun laugh hobby dream daydream contemplating confident coolness feeling absorbed pride proud positive powerful gravitas stand-out loving-it peekaboo distraction thought thinking mind meditat mindful energizer moment memor idea ideas creativity inspiration imagination innovat visionary lightbulb genius awesome"],
];
const FALLBACK_CATEGORY = "misc";

// Short names for the illustrations the app refers to by role rather than by subject, so swapping the
// art for a role is a one-line change here. Values are slugs; the script resolves the folder.
const ALIASES: Record<string, string> = {
  noData: "no-data",
  nothingHere: "void",
  notFound: "not-found",
  noResults: "searching",
  error: "server-down",
  allClear: "completed-tasks",
  celebrate: "celebrating",
  team: "team",
  payroll: "savings",
  expenses: "receipt",
  schedule: "schedule",
  leave: "out-of-office",
  signed: "contract-signed",
  documents: "add-document",
  onboarding: "onboarding",
  goals: "goal",
  feedback: "feedback",
  inbox: "inbox",
  hiring: "hiring",
};

// The brand palette, taken straight off the ramps in branding.json and mirrored by the app tokens
// (web/src/index.css, src/domain/brand.ts). Every tone below is a named step of Brand Blue, Brand Cyan or
// the brand Neutral ramp - no tone is sampled, invented or nudged - so an illustration sits in the same
// family as the chrome around it instead of importing a second blue.
//
// Lightness is what makes a tone readable, so the mid and light tones hold the CONTRAST of the ones they
// replace on both grounds (steel 2.70 -> 2.71, fill 1.47 -> 1.53, paper 1.16 -> 1.20). Ink is the
// exception: Blue 800 runs deeper than the unDraw navy it replaces (11.4:1 on white vs 8.46) - a
// deliberate call for weightier figures over contrast parity.
//
// The accents are the one place the ramp cannot be followed literally. Brand Cyan's anchor (#00F6FF,
// Cyan 400) is perceptually near-white - 1.34:1 on a white card - so a large shape painted in it vanishes
// on exactly the ground illustrations are shown against. The accents therefore step DOWN the same cyan
// ramp to where they carry: Cyan 600 for the primary highlight (2.71:1 on white, a shade stronger than the
// tone it replaces), then 500 and 300 for the second and third. Same ramp, same hue, readable.
const BRAND = {
  // The dark structure carries hair, shoes, trousers AND outlines in unDraw art (they are one colour in
  // the source, inseparable). Blue 800 is a deep navy: the figures read as weighty, clearly blue rather
  // than black on a light ground, and near-silhouette on a dark card, where steel/fill/paper carry the
  // shape instead.
  ink: "#15396d", // darkest structure (bodies, hair, shoes, outlines) - Brand Blue 800
  steel: "#d9e1e8", // grey props / secondary structure - Neutral 200, the "objects that are grey" tone
  fill: "#b8d4f2", // flat fills / props - Brand Blue 200
  paper: "#e0ecf8", // paper / the lightest surface - Brand Blue 100
  cyan: "#00dae5", // primary accent (shirts, highlights) - Brand Cyan 500
  cyanPop: "#5bfcff", // secondary accent (Cyan 300), for a second highlight in the same piece
  cyanTint: "#9efeff", // pale accent (Cyan 200), for the light half of a two-tone highlight
};
// Dark mode note: ink is deep enough that the navy shapes run close to silhouette on a dark card. That is
// the price of the deep brand navy, and it is paid safely because `steel`/`fill`/`paper` (roughly half the
// structural area in unDraw art) carry the shape on a dark ground, and because the web app backs every
// piece of card art with a white die-cut in dark mode (ART_DIECUT, web/src/lib/kudosArt.ts). If a future
// call is that dark mode matters more than depth, raise ink to Blue 500 (#2c6cbd) - it is one hex here.

// Structural colours -> the brand ramp. Two source palettes are folded in here, so this map is the single
// answer to "what colour does X become": the raw unDraw palettes (the package's navy-purple set and the
// CDN top-up's greys) and the slate/tailwind-blue ramp an earlier pass wrote into the files on disk. That
// is what makes `--recolour-only` work on the checked-in art without refetching anything, and it is
// idempotent - no target below is also a key.
//
// Skin/hair tones (#ed9da0, #ffb6b6, #a0616a, #f3a3a6, ...) are absent on purpose: people keep their own
// colours. So are the coral blushes (#f86d70, #ff7f8e) - too close to skin to reassign safely - and greens
// (#57b894, #8ed16f): a plant or a tick reads green, and the brand has no green to offer it.
const RECOLOUR: Record<string, string> = {
  // darkest structure (bodies, outlines): unDraw's navy-purples, near-blacks, and the previous slate-500
  "#2f2e41": BRAND.ink,
  "#2f2e43": BRAND.ink,
  "#090814": BRAND.ink,
  "#1a1a1a": BRAND.ink,
  "#000": BRAND.ink,
  "#000000": BRAND.ink,
  "#010001": BRAND.ink,
  "#535461": BRAND.ink,
  "#575a89": BRAND.ink,
  "#464a5f": BRAND.ink,
  "#3a3768": BRAND.ink,
  "#3f3d58": BRAND.ink,
  "#444053": BRAND.ink,
  "#65617d": BRAND.ink,
  "#64748b": BRAND.ink,
  "#4f6987": BRAND.ink,
  // secondary structure
  "#3f3d56": BRAND.steel,
  "#d0cde1": BRAND.steel,
  "#d6d6e3": BRAND.steel,
  "#b6b3c5": BRAND.steel,
  "#6f6f6f": BRAND.steel,
  "#b3b3b3": BRAND.steel,
  "#a8a8a8": BRAND.steel,
  "#707070": BRAND.steel,
  "#94a3b8": BRAND.steel,
  "#88a3b9": BRAND.steel,
  // flat fills / props
  "#e6e6e6": BRAND.fill,
  "#e0e0e0": BRAND.fill,
  "#cacaca": BRAND.fill,
  "#ccc": BRAND.fill,
  "#cccccc": BRAND.fill,
  "#cbcbcb": BRAND.fill,
  "#e4e4e4": BRAND.fill,
  "#e5e5e5": BRAND.fill,
  "#e2e3e4": BRAND.fill,
  "#cfcce0": BRAND.fill,
  "#cbd5e1": BRAND.fill,
  "#c3d4df": BRAND.fill,
  // paper / lightest surface
  "#f2f2f2": BRAND.paper,
  "#f0f0f0": BRAND.paper,
  "#f1f1f1": BRAND.paper,
  "#f5f5f5": BRAND.paper,
  "#fafafa": BRAND.paper,
  "#e6e7e8": BRAND.paper,
  "#fff": BRAND.paper,
  "#ffffff": BRAND.paper,
  "#e2e8f0": BRAND.paper,
  "#e0ecf0": BRAND.paper,
  // accents -> the vivid brand teal, so a highlight still reads as a highlight - and so the colour the eye
  // lands on first is the one the logo is known by.
  "#ff6584": BRAND.cyan,
  "#ff6884": BRAND.cyan,
  "#6c63ff": BRAND.cyan,
  "#3b82f6": BRAND.cyan,
  "#2181ca": BRAND.cyan,
  // golds -> the lighter teal. The brand axis has no warm end, and a second highlight that stayed amber
  // would be the only non-brand colour left in the set; a lighter teal keeps two accents distinguishable.
  "#fbd56f": BRAND.cyanPop,
  "#fbbf24": BRAND.cyanPop,
  "#ffd037": BRAND.cyanPop,
  "#fed253": BRAND.cyanPop,
  "#ffcc00": BRAND.cyanPop,
  "#ffd865": BRAND.cyanPop,
  "#ffd77c": BRAND.cyanPop,
  "#29bcba": BRAND.cyanPop,
  "#ffe9b3": BRAND.cyanTint,
  "#cbebeb": BRAND.cyanTint,
  // Saturated near-variants of the two accents above. unDraw's CDN art is drawn by many hands, so the
  // same accent arrives a shade off (#fd6584 for #ff6584, #7f77ff for #6c63ff). Too saturated for the
  // structural fallback in recolour() to touch, and near-misses are exactly what leaves one stray
  // non-brand pop in an otherwise branded piece, so they are named here.
  "#fd6584": BRAND.cyan,
  "#ff748e": BRAND.cyan,
  "#fc6681": BRAND.cyan,
  "#7f77ff": BRAND.cyan,
  "#64b2f0": BRAND.cyan,
  // Reds are left alone deliberately: in errors-warnings art they carry the meaning, and a cyan alert
  // would be worse than an off-brand one.

  // The palette the PREVIOUS pass wrote to disk, mapped rung-for-rung onto the current one. This is what
  // lets --recolour-only repaint the checked-in art offline instead of refetching 1700 files, and it is
  // why the map has to carry old palettes as well as raw unDraw ones. Idempotent: no value above or below
  // appears as a key, and snapToRamp() either leaves the new tones alone (too saturated / too cool) or
  // snaps them to themselves, so a second run is a no-op.
  "#2a4b8c": BRAND.ink,
  "#243289": BRAND.ink,
  "#83a1b9": BRAND.steel,
  "#bedadf": BRAND.fill,
  "#e2f1f3": BRAND.paper,
  "#36c2c9": BRAND.cyan,
  "#75d5d7": BRAND.cyanPop,
  "#a9e6e8": BRAND.cyanTint,
  // ...and the pass before this one (Blue-700 ink / Neutral-400 steel / Cyan-600 accent), rung-for-rung.
  // #b8d4f2 / #e0ecf8 are unchanged between the two, and the old #00dae5 / #5bfcff accents are now targets
  // (they merge into the new primary/secondary accent untouched), so only these three need keys.
  "#1d4c91": BRAND.ink,
  "#8f9fb1": BRAND.steel,
  "#00adc0": BRAND.cyan,
  // ...and the two passes before THIS one (Blue-500 then Blue-950 ink). Everything else is unchanged
  // across them, so the old inks are the only keys a repaint of the checked-in art needs. Both are too
  // saturated for snapToRamp's cool cutoff (s 0.62 and 0.82 > 0.33), so they must be named.
  "#2c6cbd": BRAND.ink,
  "#071326": BRAND.ink,
  // Self-map: steel is desaturated enough that snapToRamp would otherwise re-classify it by lightness on
  // the next run (l 0.88 sits nearer the fill rung). A key that paints a colour itself is the one safe
  // exception to "no target is also a key" - it exists purely to pin idempotency.
  "#d9e1e8": BRAND.steel,

  // Structural blue-greys that land just OVER snapToRamp's `s > 0.33` cutoff and so slip through it. The
  // cutoff cannot simply be raised: it is the only thing protecting third-party brand marks, and those run
  // from Facebook's #3b5998 (s 44%) up to LinkedIn's #0077b5 (s 100%) - straight through the same band.
  // Naming these individually is the safe half of that trade, since a key can only ever repaint itself.
  // Real logo blues (#0077b5, #00aced, #3b5998, #61dafb, #009688, #0078d4, ...) stay put deliberately: a
  // LinkedIn glyph in our navy would be wrong, not on-brand.
  "#192534": BRAND.ink,
  "#1d2366": BRAND.ink,
  "#1e1637": BRAND.ink,
  "#a1c4f5": BRAND.fill,
  "#bdd3e8": BRAND.fill,
  "#c4c8e2": BRAND.fill,
  "#ced7e7": BRAND.fill,
  "#d1d9ec": BRAND.fill,
  "#d4dfec": BRAND.fill,
  "#ceddf9": BRAND.paper,
  "#d7e5f2": BRAND.paper,
  "#dce6f2": BRAND.paper,
  "#dce7ff": BRAND.paper,
  "#dedff7": BRAND.paper,
  "#dfe6f5": BRAND.paper,
  "#e3e8f4": BRAND.paper,
  "#e7effd": BRAND.paper,
  "#e8f4ff": BRAND.paper,
  "#e8f5ff": BRAND.paper,
  "#f0f5fa": BRAND.paper,
  "#f1faff": BRAND.paper,
  "#feffff": BRAND.paper,
  "#fffeff": BRAND.paper,
};

const ACCENT = BRAND.cyan;
const ROOT = join(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "web", "public", "assets", "illustrations");
const PATHS_TS = join(ROOT, "web", "src", "lib", "illustrationPaths.ts");
const PKG = "undraw-svg";
const SKIP_CDN = process.argv.includes("--no-cdn");
// Re-run only the recolour, over the art already on disk. For a palette change, which is the one edit that
// needs no new files: refetching 1700 illustrations to repaint them would be pointless, and the CDN top-up
// would be a second chance to fail. RECOLOUR maps both the raw unDraw palettes and the palette the last
// pass wrote, so this converges to the same bytes a full run would produce.
const RECOLOUR_ONLY = process.argv.includes("--recolour-only");

type Meta = { slug: string; title: string; keywords?: string[]; media: string; width?: number; height?: number };

const TERMS: [string, string[]][] = CATEGORIES.map(([cat, terms]) => [cat, terms.split(" ")]);

function categorise(slug: string, meta: Meta | undefined): string {
  const blob = `${meta?.title ?? slug} ${(meta?.keywords ?? []).join(" ")} ${slug}`.toLowerCase();
  for (const [cat, terms] of TERMS) if (terms.some((t) => blob.includes(t))) return cat;
  return FALLBACK_CATEGORY;
}

function curl(url: string): string {
  return execFileSync("curl", ["-sfL", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// The structural rungs in lightness order - what an unmapped structural colour snaps to.
const RAMP: [number, string][] = [
  [0.34, BRAND.ink],
  [0.63, BRAND.steel],
  [0.84, BRAND.fill],
  [0.93, BRAND.paper],
];

function hsl(hex: string): { h: number; s: number; l: number } {
  const n = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h, s, l };
}

// Anything the map missed, snapped onto the ramp by lightness. Necessary because unDraw's structural greys
// and navy-purples arrive in dozens of near-identical shades (#2e2e41 next to #2f2e41, six flavours of light
// grey) that no hand-written list stays ahead of - and one unconverted grey in a piece reads as a smudge.
// Deliberately narrow, since the cost of over-reaching is a blue face: only greys (any hue, but washed out)
// and the cool half of the wheel qualify. Warm hues are skin, and greens are plants and ticks - a brand with
// no green has nothing better to offer them.
function snapToRamp(hex: string): string | null {
  const { h, s, l } = hsl(hex);
  // Near-black is outline ink whatever the maths says: at this lightness a couple of hex steps between
  // channels compute as high saturation (#06060f reads as a "saturated blue"), which would otherwise let
  // every near-black variant through unconverted.
  const ink = l < 0.12;
  const grey = s < 0.12;
  const cool = h >= 165 && h <= 330;
  if (!ink && !grey && (!cool || s > 0.33)) return null;
  return RAMP.reduce((best, rung) => (Math.abs(rung[0] - l) < Math.abs(best[0] - l) ? rung : best))[1];
}

function recolour(svg: string): string {
  return svg
    .replace(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g, (hex) => {
      const key = hex.toLowerCase();
      return RECOLOUR[key] ?? snapToRamp(key) ?? hex;
    })
    .replace(/currentColor/g, ACCENT);
}

function shrink(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+data-name="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// The palette paragraph, shared by the README writer below and by --recolour-only (which rewrites it in
// place) so the README can never describe a palette the files no longer use.
const COLOUR_NOTE = [
  "Colours are named steps of the brand ramps in `branding.json`, the same ones the app tokens use",
  "(`web/src/index.css`, `src/domain/brand.ts`) - nothing here is sampled or invented. Structure is",
  `${BRAND.ink} (Blue 800 - bodies, hair, shoes and outlines, one colour in the unDraw source) /`,
  `${BRAND.steel} (Neutral 200, grey props) / ${BRAND.fill} (Blue 200) / ${BRAND.paper} (Blue 100);`,
  `accents are ${BRAND.cyan} / ${BRAND.cyanPop} / ${BRAND.cyanTint} (Cyan 500/300/200) - shirts and`,
  "highlights carry the primary accent. The accents stay off the ramp's #00F6FF anchor, which is",
  "perceptually near-white (1.34:1 on a white card) and would vanish on the ground illustrations sit on.",
  "Skin tones, greens and reds are untouched (reds carry meaning in the errors-warnings art).",
  "There is no per-theme variant on purpose - the app theme is a user preference, so a",
  "`prefers-color-scheme` block inside the file would be wrong for anyone forcing it against their OS.",
];

// --recolour-only: repaint the art already on disk and bring the README's palette paragraph with it.
if (RECOLOUR_ONLY) {
  let touched = 0;
  let scanned = 0;
  for (const cat of readdirSync(OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const dir = join(OUT_DIR, cat.name);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".svg"))) {
      const path = join(dir, file);
      const before = readFileSync(path, "utf8");
      const after = recolour(before);
      scanned++;
      if (after !== before) {
        writeFileSync(path, after);
        touched++;
      }
    }
  }
  const readmePath = join(OUT_DIR, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  // The paragraph runs from "Colours are" to the next blank line; replacing the whole block keeps the
  // rewrite honest even when the new note has a different number of lines than the old one.
  // Test the match, not the result: on a second run the paragraph is already right, and treating "no change"
  // as "not found" would cry wolf every time.
  const para = /^Colours are[\s\S]*?(?=\n\n)/m;
  if (!para.test(readme)) console.warn("! README palette paragraph not found - check it by hand");
  else writeFileSync(readmePath, readme.replace(para, COLOUR_NOTE.join("\n")));
  console.log(`recoloured ${touched}/${scanned} svg (accent ${ACCENT}, teal ${BRAND.cyan})`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "undraw-"));
try {
  const registry = JSON.parse(curl(`https://registry.npmjs.org/${PKG}`));
  const version = registry["dist-tags"].latest;
  const tarball: string = registry.versions[version].dist.tarball;
  console.log(`${PKG}@${version}`);
  execFileSync("sh", ["-c", `curl -sfL ${JSON.stringify(tarball)} | tar xz -C ${JSON.stringify(tmp)}`]);

  const srcDir = join(tmp, "package", "svgs");
  const meta: Meta[] = JSON.parse(readFileSync(join(tmp, "package", "illustrations.json"), "utf8"));
  const bySlug = new Map(meta.map((m) => [m.slug, m]));

  rmSync(OUT_DIR, { recursive: true, force: true });

  type Entry = { slug: string; dir: string; bytes: number };
  const written = new Map<string, Entry>();
  const write = (slug: string, raw: string) => {
    const dir = categorise(slug, bySlug.get(slug));
    const out = shrink(recolour(raw)) + "\n";
    mkdirSync(join(OUT_DIR, dir), { recursive: true });
    writeFileSync(join(OUT_DIR, dir, `${slug}.svg`), out);
    written.set(slug, { slug, dir, bytes: out.length });
  };

  for (const file of readdirSync(srcDir)) {
    if (file.endsWith(".svg")) write(file.slice(0, -4), readFileSync(join(srcDir, file), "utf8"));
  }
  console.log(`  ${written.size} from package`);

  // The package can trail upstream, so anything in its own metadata that it did not ship comes from the
  // CDN. Failures here are not fatal: the package set is already complete enough to build against.
  const missing = meta.filter((m) => !written.has(m.slug) && m.media);
  if (missing.length && !SKIP_CDN) {
    const failed: string[] = [];
    let ok = 0;
    for (const m of missing) {
      try {
        write(m.slug, curl(m.media));
        ok++;
      } catch {
        failed.push(m.slug);
      }
    }
    console.log(`  ${ok} from cdn.undraw.co${failed.length ? ` (${failed.length} failed: ${failed.slice(0, 5).join(", ")}…)` : ""}`);
  } else if (missing.length) {
    console.log(`  skipped ${missing.length} cdn-only illustrations (--no-cdn)`);
  }

  const entries = [...written.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  const paths = entries.map((e) => `${e.dir}/${e.slug}`);

  // Picker index. Fetched on demand by the browser, never bundled.
  writeFileSync(
    join(OUT_DIR, "index.json"),
    JSON.stringify(
      entries.map(({ slug, dir }) => {
        const m = bySlug.get(slug);
        const entry: Record<string, unknown> = { slug, dir, title: m?.title ?? titleCase(slug) };
        if (m?.keywords?.length) entry.keywords = m.keywords;
        if (m?.width && m?.height) entry.aspect = Number((m.width / m.height).toFixed(3));
        return entry;
      }),
    ),
  );

  // Path union + alias paths. Types and a 19-entry map, so the 1700-entry index stays out of the bundle.
  const missingAliases = Object.entries(ALIASES).filter(([, slug]) => !written.has(slug));
  writeFileSync(
    PATHS_TS,
    [
      "// GENERATED by scripts/fetchIllustrations.ts - do not edit.",
      "// One entry per file under web/public/assets/illustrations. The union is a type, so it costs nothing",
      "// at runtime while still catching a typo in a path; ALIAS_PATHS is the only part that ships.",
      "",
      "export type IllustrationPath =",
      ...paths.map((p) => `  | "${p}"`),
      "  ;",
      "",
      "export const ALIAS_PATHS = {",
      ...Object.entries(ALIASES)
        .filter(([, slug]) => written.has(slug))
        .map(([alias, slug]) => `  ${alias}: "${written.get(slug)!.dir}/${slug}",`),
      "} as const satisfies Record<string, IllustrationPath>;",
      "",
      `export const ILLUSTRATION_COUNT = ${entries.length};`,
      "",
      "export const ILLUSTRATION_CATEGORIES = [",
      ...[...new Set(entries.map((e) => e.dir))].sort().map((c) => `  "${c}",`),
      "] as const;",
      "",
    ].join("\n"),
  );

  // README with the per-category tally, so the folder layout is documented where someone will look.
  const byCat = new Map<string, number>();
  for (const e of entries) byCat.set(e.dir, (byCat.get(e.dir) ?? 0) + 1);
  const bytes = entries.reduce((a, e) => a + e.bytes, 0);
  writeFileSync(
    join(OUT_DIR, "README.md"),
    [
      "# Illustrations",
      "",
      "The full [unDraw](https://undraw.co) set (MIT), generated by",
      "`node --experimental-strip-types scripts/fetchIllustrations.ts`. Do not hand-edit: change the",
      "script and re-run. Sources are the `undraw-svg` npm tarball plus a CDN top-up for illustrations",
      "the package has not shipped yet.",
      "",
      `${entries.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB. Served as plain files and loaded by \`<img>\`, so an`,
      "illustration that never renders costs nothing.",
      "",
      "unDraw publishes no categories of its own - its metadata is title, keywords (tokenised title",
      "words), dimensions and a hash - so the folders below come from the ordered term lists in",
      "`CATEGORIES` in that script, first match winning. `misc` is where an illustration lands when no",
      "list claims it. Re-run after editing the lists to reshuffle.",
      "",
      ...COLOUR_NOTE,
      "",
      "- `index.json` - slug, dir, title, keywords, aspect. For a picker to fetch on demand; not bundled.",
      "- `web/src/lib/illustrationPaths.ts` - generated path union, alias paths, category list.",
      "- `web/src/lib/illustrations.ts` - `illustrationSrc()` and the alias type.",
      "",
      "## Categories",
      "",
      "| Category | Count |",
      "| --- | --- |",
      ...[...byCat.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `| \`${c}/\` | ${n} |`),
      "",
      "## Aliases",
      "",
      "| Alias | Path |",
      "| --- | --- |",
      ...Object.entries(ALIASES)
        .filter(([, slug]) => written.has(slug))
        .map(([k, slug]) => `| \`${k}\` | \`${written.get(slug)!.dir}/${slug}\` |`),
      "",
    ].join("\n"),
  );

  if (missingAliases.length) {
    console.error(`\nALIAS TARGETS MISSING: ${missingAliases.map(([k, v]) => `${k} -> ${v}`).join(", ")}`);
    process.exitCode = 1;
  }
  const tally = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n${entries.length} illustrations, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${byCat.size} categories:`);
  for (const [cat, n] of tally) console.log(`  ${String(n).padStart(4)}  ${cat}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
