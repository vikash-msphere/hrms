// Kudos recognition config (settings key "kudos"): the weighted LEVEL ladder + a flat CATEGORY taxonomy.
// Curated day-one defaults - richer than domain/kudos.ts's DEFAULT_KUDOS_CONFIG (which ships empty categories
// and a 3-rung ladder). HR edits this in Settings at runtime. Level points feed the recognition leaderboard;
// categories carry a lucide icon NAME (web/src/lib/categoryIcons.tsx) plus example remarks (`prompts`) the web
// rotates through the give-kudos message placeholder to beat writer's block. "Appreciation" and "Exceptional"
// are kept as level names so the seeded kudos card templates (which match on {level}) still apply.
import { T0, q, j } from "../lib";
import type { KudosConfig } from "../../src/domain/kudos";

// Exported so bootstrap/genDemo.ts can give each demo kudos one of the stickers its own category is paired with,
// rather than keeping a second copy of that pairing.
export const KUDOS_CONFIG: KudosConfig = {
  levels: [
    { name: "Appreciation", points: 1 },
    { name: "Impact", points: 2 },
    { name: "Exceptional", points: 3 },
    { name: "Legendary", points: 5 },
  ],
  categories: [
    {
      name: "Teamwork",
      icon: "handshake",
      art: ["creative-buddy.png", "imagination.png"],
      prompts: [
        "You made the whole sprint feel lighter - thanks for pairing on the tricky bits without ever being asked.",
        "When the deadline moved up, you pulled everyone together instead of panicking. That's the glue this team runs on.",
        "Thanks for looping in QA early and keeping design in sync - the handoff was the smoothest we've had.",
        "You never say \"not my job\". Every time someone's stuck, you're already in the thread helping.",
        "The way you shared credit in the demo said everything about how you work. Grateful to be on your team.",
      ],
    },
    {
      name: "Innovation",
      icon: "lightbulb",
      art: ["out-of-the-box.png", "brain-storming.png"],
      prompts: [
        "Your \"what if we just...\" idea in standup cut a two-week task down to two days. Brilliant.",
        "You questioned an assumption everyone else had accepted for years - and you were right.",
        "The prototype you hacked together over lunch became the plan of record. That's how change starts here.",
        "Thanks for trying the unconventional route when the safe one kept failing. It paid off big.",
        "You didn't just spot the problem - you brought three ways to fix it. That mindset is contagious.",
      ],
    },
    {
      name: "Customer Focus",
      icon: "heart",
      art: ["i-heart-design.png", "think-about.png"],
      prompts: [
        "You stayed on that support call until the customer was genuinely unblocked, not just handed off. They noticed - so did we.",
        "The way you translated the client's vague ask into exactly what they needed was masterful.",
        "You fought for the user in that roadmap debate, and the product is better for it.",
        "Thanks for following up with the customer a week later just to make sure the fix stuck. That's rare.",
        "You turned an angry escalation into a renewal. Enough said.",
      ],
    },
    {
      name: "Ownership",
      icon: "shield-check",
      art: ["hard-work.png", "tidy-up.png"],
      prompts: [
        "You saw the incident, took the lead, and drove it to resolution before anyone even assigned it. Textbook ownership.",
        "\"I'll take that\" might be your catchphrase - and you always follow through.",
        "You owned the miss in the retro without excuses, then fixed the process so it can't happen again. Huge respect.",
        "The migration nobody wanted to touch? You quietly finished it. Thank you.",
        "You treat every corner of this product like your name is on it. Because of you, it shows.",
      ],
    },
    {
      name: "Excellence",
      icon: "award",
      art: ["embrace-your-perfection.png", "you-did-it.png"],
      prompts: [
        "Your PRs are the ones people open just to learn from. The bar you set lifts everyone.",
        "Zero defects, ahead of schedule, documented to perfection. That release was a masterclass.",
        "You sweat the details nobody sees - and it's exactly why everything you ship feels solid.",
        "The report you put together was so thorough leadership reused it verbatim. Outstanding work.",
        "Quality isn't a phase for you, it's a habit. This month proved it again.",
      ],
    },
    {
      name: "Leadership",
      icon: "crown",
      art: ["ready-set-go.png", "thinking-out-loud.png"],
      prompts: [
        "You didn't need the title to lead - the room naturally turned to you, and you delivered.",
        "Thanks for shielding the team from the noise so we could focus. That's real leadership.",
        "The way you coached the new joiner through their first release doubled their confidence.",
        "You made the hard call, explained it honestly, and carried the team through it. That earned trust.",
        "In the toughest week of the quarter, your calm set the tone for everyone.",
      ],
    },
    {
      name: "Going the Extra Mile",
      icon: "rocket",
      art: ["explore-new-world.png", "focus-time.png"],
      prompts: [
        "You stayed late to get the demo across the line - and never once made it feel like a favor.",
        "That fix you shipped on Saturday saved Monday for the whole team. Thank you.",
        "You didn't stop at the fix - you wrote the runbook, added alerts, and closed the loop for good.",
        "Way beyond the ask, way ahead of the deadline. You went above and beyond, again.",
        "Nobody would have blamed you for stopping at \"good enough\". You didn't. It shows.",
      ],
    },
    {
      name: "Helping Hand",
      icon: "hand-heart",
      art: ["coffee-time.png", "good-job.png"],
      prompts: [
        "You dropped your own work to unblock mine, twice this week. I owe you one - or five.",
        "Thanks for the patient walkthrough of the deploy pipeline. You turned my worst day into a learning day.",
        "New folks always land on their feet here - mostly because you're the first to offer help.",
        "That 11pm \"need a hand?\" message meant more than you know.",
        "You answer every question like it's a great question. It makes people brave enough to ask.",
      ],
    },
    {
      name: "Learning & Growth",
      icon: "book-open",
      art: ["open-mind.png", "creative-mind.png"],
      prompts: [
        "You picked up a whole new stack in three weeks and shipped with it. Seriously impressive.",
        "The lunch-and-learn you ran had the whole team taking notes. Teach us more!",
        "You took the feedback from last cycle and visibly turned it into strength. That takes real character.",
        "Watching you grow from asking the questions to answering them has been the best part of this quarter.",
        "You turned your certification study into shared notes for everyone. Learning, multiplied.",
      ],
    },
    {
      name: "Positivity",
      icon: "smile",
      art: ["relax-time.png", "drawing.png"],
      prompts: [
        "Even when the build was red and the coffee machine died, you kept the team laughing. Priceless.",
        "Your energy in Monday standups genuinely sets up the whole week.",
        "Thanks for celebrating the small wins - you make progress feel like progress.",
        "You find the silver lining in every incident review, and somehow it always turns into an action item.",
        "The team is measurably happier when you're in the room. Never change.",
      ],
    },
  ],
};

export function kudos(): string {
  return `INSERT INTO settings (key,value,updated_at) VALUES\n (${q("kudos")},${j(KUDOS_CONFIG)},${T0});`;
}
