import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  // Card templates (kudos/announcements) are HR-editable HTML stored in the DB, so their Tailwind classes are
  // NOT in the scanned source above. Safelist the recognition palette + the per-category/level decoration
  // vocabulary the seed cards use, so the cards render reliably and HR has a predictable kit to edit within.
  safelist: [
    // Colour palette: bg/from/via/to/text/ring/border × 14 families × shades, with dark variants.
    {
      pattern: /(bg|from|via|to|text|ring|border)-(slate|emerald|sky|blue|indigo|violet|fuchsia|rose|amber|yellow|orange|pink|teal|green)-(50|100|200|300|400|500|600|700|800|900|950)/,
      variants: ["dark"],
    },
    // Decoration utilities the kudos cards use that don't appear in scanned source (creative glow blobs, the
    // gradient wash + accent rail, the quote mark, the message hero). Explicit so the bundle includes them.
    "to-card", "bg-gradient-to-r", "blur-2xl", "blur-3xl", "rounded-2xl",
    "h-0.5", "h-36", "w-36", "h-40", "w-40", "h-32", "w-32", "h-64", "w-64", "h-96", "w-96",
    "inset-x-0", "pointer-events-none", "-right-12", "-top-12", "-bottom-16", "-left-10", "-bottom-4", "-right-4",
    "-translate-x-1/2", "-translate-y-1/2",
    "opacity-10", "opacity-20", "opacity-25", "dark:opacity-20", "dark:opacity-25", "dark:opacity-30",
    "ring-offset-card", "text-[15px]", "text-foreground/70",
    "min-h-[440px]", "p-8", "flex", "flex-col", "justify-center",
    "h-28", "w-28", "h-24", "w-24", "ring-offset-4", "flex-1", "gap-5", "py-6",
    "text-2xl", "text-lg", "max-w-md", "text-[11px]", "tracking-wider", "px-3", "py-1",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          border: "hsl(var(--sidebar-border))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        // The raw brand ramps, for the few places that need a specific step rather than a semantic role
        // (chart series, illustration fills, decorative washes). Prefer the semantic names above: those
        // re-skin with the theme, these do not. Defined in web/src/index.css - see the palette block there.
        brand: {
          blue: {
            50: "hsl(var(--blue-50))",
            100: "hsl(var(--blue-100))",
            200: "hsl(var(--blue-200))",
            300: "hsl(var(--blue-300))",
            400: "hsl(var(--blue-400))",
            500: "hsl(var(--blue-500))",
            600: "hsl(var(--blue-600))",
            700: "hsl(var(--blue-700))",
            800: "hsl(var(--blue-800))",
            900: "hsl(var(--blue-900))",
            950: "hsl(var(--blue-950))",
          },
          cyan: {
            50: "hsl(var(--cyan-50))",
            100: "hsl(var(--cyan-100))",
            200: "hsl(var(--cyan-200))",
            300: "hsl(var(--cyan-300))",
            400: "hsl(var(--cyan-400))",
            500: "hsl(var(--cyan-500))",
            600: "hsl(var(--cyan-600))",
            700: "hsl(var(--cyan-700))",
            800: "hsl(var(--cyan-800))",
            900: "hsl(var(--cyan-900))",
            950: "hsl(var(--cyan-950))",
          },
          neutral: {
            50: "hsl(var(--neutral-50))",
            100: "hsl(var(--neutral-100))",
            200: "hsl(var(--neutral-200))",
            300: "hsl(var(--neutral-300))",
            400: "hsl(var(--neutral-400))",
            500: "hsl(var(--neutral-500))",
            600: "hsl(var(--neutral-600))",
            700: "hsl(var(--neutral-700))",
            800: "hsl(var(--neutral-800))",
            900: "hsl(var(--neutral-900))",
            950: "hsl(var(--neutral-950))",
          },
        },
      },
      // Corner radii from branding.json (Primitive.Radius 8/16/24/32), all derived from the single
      // --radius knob in index.css. md (8) is the control radius - buttons, inputs, badges; xl (16) is
      // the card radius; 2xl (24) covers dialogs/sheets; 3xl (32) is the pill-ish feature surface.
      // lg sits between md and xl for the small inline panels that 16px would over-round.
      borderRadius: {
        sm: "calc(var(--radius) - 2px)",
        md: "var(--radius)",
        lg: "calc(var(--radius) + 4px)",
        xl: "calc(var(--radius) + 8px)",
        "2xl": "calc(var(--radius) + 16px)",
        "3xl": "calc(var(--radius) + 24px)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.25s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
