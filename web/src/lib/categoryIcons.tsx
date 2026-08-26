// Kudos-category icons. Icons are stored as a kebab-case NAME (e.g. "award", "thumbs-up") drawn from the
// curated ICON_MAP below. Statically imported lucide components tree-shake into the vendor chunk - no
// per-icon code-split chunks. The picker is a searchable grid (no labels); common icons show first.
import { useMemo, useState } from "react";
import {
  Award, Trophy, Medal, Star, Crown, Gem, Sparkles, PartyPopper, Users, Handshake, Heart, HandHeart,
  ThumbsUp, ThumbsDown, Smile, Gift, BadgeCheck, Lightbulb, Rocket, Target, Zap, Flame, ShieldCheck, Leaf,
  Globe, BookOpen, Wrench, Megaphone, Clock, Tag, Check, CircleCheck, Coffee, Cake, Bell, Calendar, Camera,
  Cloud, Code, Compass, Feather, Flag, Folder, Hammer, Headphones, Home, Image, Key, Laptop, Link, Lock,
  Mail, MapPin, Mic, Monitor, Moon, Music, Package, Palette, Pencil, Phone, PieChart, Plane, Printer, Puzzle,
  Send, Settings, Ship, ShoppingBag, Smartphone, Snowflake, Sun, Umbrella, Video, Wallet, Watch, Wifi, Wind,
  Anchor, Atom, Banknote, Bike, Book, Bookmark, Briefcase, Bug, Building, Car, TrendingUp, Activity,
  BarChart3, Layers, Hand, HeartHandshake, Diamond,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

// Curated icon set, keyed by the kebab-case name we store. Statically imported so the bundler tree-shakes
// exactly these into the vendor chunk (no dynamic per-icon chunks). Add a line to widen the choice.
export const ICON_MAP: Record<string, LucideIcon> = {
  award: Award, trophy: Trophy, medal: Medal, star: Star, crown: Crown, gem: Gem, sparkles: Sparkles,
  "party-popper": PartyPopper, users: Users, handshake: Handshake, heart: Heart, "hand-heart": HandHeart,
  "thumbs-up": ThumbsUp, "thumbs-down": ThumbsDown, smile: Smile, gift: Gift, "badge-check": BadgeCheck,
  lightbulb: Lightbulb, rocket: Rocket, target: Target, zap: Zap, flame: Flame, "shield-check": ShieldCheck,
  leaf: Leaf, globe: Globe, "book-open": BookOpen, wrench: Wrench, megaphone: Megaphone, clock: Clock,
  tag: Tag, check: Check, "circle-check": CircleCheck, coffee: Coffee, cake: Cake, bell: Bell,
  calendar: Calendar, camera: Camera, cloud: Cloud, code: Code, compass: Compass, feather: Feather,
  flag: Flag, folder: Folder, hammer: Hammer, headphones: Headphones, home: Home, image: Image, key: Key,
  laptop: Laptop, link: Link, lock: Lock, mail: Mail, "map-pin": MapPin, mic: Mic, monitor: Monitor,
  moon: Moon, music: Music, package: Package, palette: Palette, pencil: Pencil, phone: Phone,
  "pie-chart": PieChart, plane: Plane, printer: Printer, puzzle: Puzzle, send: Send, settings: Settings,
  ship: Ship, "shopping-bag": ShoppingBag, smartphone: Smartphone, snowflake: Snowflake, sun: Sun,
  umbrella: Umbrella, video: Video, wallet: Wallet, watch: Watch, wifi: Wifi, wind: Wind, anchor: Anchor,
  atom: Atom, banknote: Banknote, bike: Bike, book: Book, bookmark: Bookmark, briefcase: Briefcase, bug: Bug,
  building: Building, car: Car, "trending-up": TrendingUp, activity: Activity, "bar-chart-3": BarChart3,
  layers: Layers, hand: Hand, "heart-handshake": HeartHandshake, diamond: Diamond,
};

// All selectable names. Recognition-relevant ones first so they surface before a search.
export const RELEVANT_ICONS = [
  "award", "trophy", "medal", "star", "crown", "gem", "sparkles", "party-popper",
  "users", "handshake", "heart", "hand-heart", "thumbs-up", "smile", "gift", "badge-check",
  "lightbulb", "rocket", "target", "zap", "flame", "shield-check",
  "leaf", "globe", "book-open", "wrench", "megaphone", "clock",
];
const ICON_NAMES = Object.keys(ICON_MAP);

// Render an icon by its stored name (falls back to a generic tag for blank/unknown).
export function CategoryIcon({ name, className }: { name?: string | null; className?: string }) {
  const Icon = ICON_MAP[name || ""] ?? Tag;
  return <Icon className={className} />;
}

// A searchable icon-grid picker. Trigger shows the current icon; the popover filters the curated set.
export function IconPicker({ value, onChange, className }: { value?: string; onChange: (name: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const CAP = 56; // 7 cols x 8 rows - fills the grid without a scrollbar; search narrows further
  const matches = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return RELEVANT_ICONS;
    return ICON_NAMES.filter((n) => n.includes(query));
  }, [q]);
  const list = matches.slice(0, CAP);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Pick icon" className={cn("flex h-9 w-12 items-center justify-center rounded-md border bg-background hover:bg-accent", className)}>
          <CategoryIcon name={value} className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <Input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search icons…" className="mb-2 h-8" />
        <div className="grid grid-cols-7 gap-1">
          {list.map((n) => {
            const Icon = ICON_MAP[n];
            return (
              <button
                key={n}
                type="button"
                title={n}
                onClick={() => { onChange(n); setOpen(false); }}
                className={cn("flex h-8 w-8 items-center justify-center rounded hover:bg-accent", value === n && "bg-accent ring-1 ring-primary")}
              >
                <Icon size={18} />
              </button>
            );
          })}
          {list.length === 0 && <p className="col-span-7 py-3 text-center text-xs text-muted-foreground">No icons match.</p>}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{!q.trim() ? `Common icons shown. Search all ${ICON_NAMES.length}.` : matches.length > CAP ? `${matches.length} matches - refine to narrow.` : `${matches.length} match${matches.length === 1 ? "" : "es"}.`}</p>
      </PopoverContent>
    </Popover>
  );
}
