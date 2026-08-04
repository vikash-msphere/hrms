# Kudos stickers

Artwork for kudos cards on the board. A card renders exactly what its own `announcements.illustration`
holds - either a sticker from here or an unDraw illustration from `../illustrations` - and no image at all
when that is empty. The card is designed to read fine without one.

The card's art is a stored, giver-owned pick, not a render-time lookup. Picking a category in the composer
seeds `illustration` with one of that category's stickers, chosen at random from the set (see PostComposer);
the giver can then swap it for anything else or clear it. Because it is stored, the card keeps its sticker
forever - editing the category's set in Settings changes what future cards are seeded with, never what is
already on the wall.

Every sticker has its slogan drawn into the picture ("Good Job!", "Out Of The Box"), so which category a
sticker suits is a judgement about that wording and **not** derivable from the file name. The pairing is
therefore data: a LIST per category in `settings/kudos` (`categories[].art`), editable in Settings → Kudos
(the sticker button beside each category's icon). Nothing in the code maps a category name to a file name.

Adding a sticker: drop the file here and add its name to `KUDOS_ART_FILES` in
`web/src/lib/kudosArt.ts`, which is what the Settings picker lists. The name must match the file on disk
exactly - the picker filters a saved set through this list, so a typo silently drops that sticker.

## Seeded pairing

`bootstrap/collections/kudos.ts` ships two stickers for each of the ten seeded categories - all 20 files
used, none twice. HR can change any of them at runtime.

| Category | Stickers | Slogans on the artwork |
| --- | --- | --- |
| Teamwork | `creative-buddy` · `imagination` | Creative Buddy / Imagination |
| Innovation | `out-of-the-box` · `brain-storming` | Out Of The Box / B(Rain) Storming |
| Customer Focus | `i-heart-design` · `think-about` | I Heart Design / Think About |
| Ownership | `hard-work` · `tidy-up` | Hard Work / Tidy Up |
| Excellence | `embrace-your-perfection` · `you-did-it` | Embrace Your Perfection / You Did It |
| Leadership | `ready-set-go` · `thinking-out-loud` | Ready Set Go / Thinking Out Loud |
| Going the Extra Mile | `explore-new-world` · `focus-time` | Explore New World / Focus Time |
| Helping Hand | `coffee-time` · `good-job` | Coffee Time / Good Job! |
| Learning & Growth | `open-mind` · `creative-mind` | Open Mind / Creative Mind |
| Positivity | `relax-time` · `drawing` | Relax Time / Drawing |
