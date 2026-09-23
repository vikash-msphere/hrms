import { navigate } from "@/router";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";

export type Person = { id: string; name: string; photo?: string };

/**
 * A face and a name per row, each one a way to that person's profile.
 *
 * Lives in the direct-reports hover panel. "5 people" answers how many and nothing else, which is the wrong
 * answer when the question a manager's record raises is WHO - and once the names are on screen, the obvious
 * next thing to want is the person, so every row goes there.
 *
 * Photos come through `PhotoAvatar`, so they ride the existing batched photo fetch rather than firing a
 * request per face.
 */
export function PeopleList({ people, max = 12 }: { people: Person[]; max?: number }) {
  const shown = people.slice(0, max);
  // Capped so a manager with thirty reports gets a readable list rather than a column taller than the window.
  const rest = people.length - shown.length;
  return (
    <div className="flex flex-col">
      {shown.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => navigate(`employees/${p.id}`)}
          className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {/* The size has to be spelled out: PhotoAvatar's `className` REPLACES its default ("h-16 w-16"),
              so omitting it leaves an avatar with no box at all. */}
          <PhotoAvatar employeeId={p.id} name={p.name} photo={p.photo} className="h-6 w-6 shrink-0 rounded-md" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
      {rest > 0 && <span className="px-2 py-1.5 text-xs text-muted-foreground">and {rest} more</span>}
    </div>
  );
}
