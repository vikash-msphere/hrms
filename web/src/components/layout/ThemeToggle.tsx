import { Sun, Moon, Monitor, Check } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

// Top-bar theme switcher: an icon button reflecting the live mode, opening an explicit Light/Dark/System
// menu (clearer than a blind cycle, and "System" stays selectable).
export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  const TriggerIcon = resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Theme"
        className="flex h-9 w-9 items-center justify-center rounded-lg border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <TriggerIcon className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {OPTIONS.map((o) => {
          const Icon = o.icon;
          const active = theme === o.value;
          return (
            <DropdownMenuItem key={o.value} onClick={() => setTheme(o.value)}>
              <Icon className="h-4 w-4" />
              {o.label}
              <Check className={cn("ml-auto h-4 w-4", active ? "opacity-100" : "opacity-0")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
