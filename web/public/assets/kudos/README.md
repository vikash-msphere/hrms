# Kudos stickers

Artwork for kudos cards on the board. A card shows, in order:

1. the illustration the giver picked while posting (`announcements.illustration`, the unDraw set in
   `../illustrations`), else
2. the sticker configured on its category (`settings/kudos` → `categories[].art`), else
3. no image at all - the card is designed to read fine without one.

Every sticker has its slogan drawn into the picture ("Good Job!", "Out Of The Box"), so which category a
sticker suits is a judgement about that wording and **not** derivable from the file name. The pairing is
therefore data: a LIST per category in `settings/kudos` (`categories[].art`), editable in Settings → Kudos
(the sticker button beside each category's icon). Nothing in the code maps a category name to a file name.

A category with more than one sticker varies its cards. Which sticker a card gets is indexed by a hash of
that card's own resource path (`pickKudosArt` in `web/src/lib/kudosArt.ts`), so the choice is stable: a card
keeps its sticker across reloads, re-renders, and new kudos arriving above it. A positional round-robin would
look identical at first and then reshuffle the whole wall the moment anything moved. Editing the list in
Settings does re-pick, since the pairing is live config rather than a snapshot taken at post time.

Adding a sticker: drop the file here and add its name to `KUDOS_ART_FILES` in
`web/src/lib/kudosArt.ts`, which is what the Settings picker lists.

## Seeded pairing

`bootstrap/collections/kudos.ts` ships two stickers for each of the ten seeded categories - all 20 files
used, none twice. HR can change any of them at runtime.

| Category | Stickers | Slogans on the artwork |
| --- | --- | --- |
| Teamwork | `creative-buddy` · `imagination` | Creative Buddy / Imagination |
| Innovation | `out-of-the-box` · `brain-storming` | Out Of The Box / B(Rain) Storming |
| Customer Focus | `I-heart-design` · `think-about` | I Heart Design / Think About |
| Ownership | `hard-work` · `tiddy-up` | Hard Work / Tidy Up |
| Excellence | `embrace-your-perfection` · `you-did-it` | Embrace Your Perfection / You Did It |
| Leadership | `ready-set-go` · `thinking-out-loud` | Ready Set Go / Thinking Out Loud |
| Going the Extra Mile | `explore-new-world` · `focus-time` | Explore New World / Focus Time |
| Helping Hand | `coffee-time` · `good-job` | Coffee Time / Good Job! |
| Learning & Growth | `open-mind` · `creative-mind` | Open Mind / Creative Mind |
| Positivity | `relex-time` · `drawin` | Relax Time / Drawing |
