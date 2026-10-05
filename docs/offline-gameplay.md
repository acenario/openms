# Offline gameplay guide

> [!NOTE]
> The offline client has been removed. This page is retained as historical evidence for earlier builds; current behavior and authority are documented in the [online feature map](server/offline-parity.md).

## Behavior checklist

| Area                              | Current contract                                                                                               | Read next                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Movement and action               | Recovered 30 ms kernel, original geometry and avatar actions                                                   | [Movement](movement-parity.md) · [Physics](physics-evidence.md)     |
| Combat and progression            | Local HP/mob authority with recovered supported calculations and labeled reference rules                       | [Combat](offline-combat.md)                                         |
| Skills and effects                | Learned admission, costs, cooldowns, shared timed effects; 485 source-capable / 49 unavailable classifications | [Skills](skills.md)                                                 |
| NPCs and quests                   | Original target geometry, authored dialogue and bounded Cosmic-reference programs                              | [NPCs](ingame-life.md) · [Quests](ingame-quests.md)                 |
| Items and drops                   | UID-bearing instances, atomic inventory/equipment changes, original motion and pickup                          | [Drop motion](drop-motion.md) · [Saves](offline-saves.md)           |
| Portals and camera                | Named arrival, atomic scene replacement, recovered camera history                                              | [Portals](ingame-portals.md)                                        |
| Character and inspection          | Schema 8, validated presets and isolated development experiments                                               | [Character](offline-profile.md) · [Inspection](inspection-tools.md) |
| Social and commerce               | Explicit local peers and shared transaction rules; local peers are not network players                         | [UI](ingame-ui.md) · [Binding actions](offline-binding-actions.md)  |
| Interface, audio and effects      | Original resource ownership, modal/focus rules and trusted audio unlock                                        | [UI](ingame-ui.md) · [Audio](ingame-audiovisual.md)                 |
| Delivery                          | Verified immutable release installation, separate from character saves                                         | [Asset delivery](asset-delivery.md)                                 |
| Reactors, pets and other entities | Supported owned controllers; script rewards and pet equipment remain limited                                   | [Entity families](ingame-entities.md)                               |

## Operational clocks and ownership

| Clock                                  | Duration / behavior                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| Movement and player action integration | 30 ms per tick                                                                     |
| Positive-hit protection                | 1500 ms; RGB phases every 60 ms                                                    |
| Hit expression                         | Independent 1500 ms lifetime                                                       |
| Alert/brace                            | 5000 ms; changes grounded idle and standing HP-recovery eligibility                |
| Ordinary HP / MP recovery              | Independent 10000 ms accumulators; applicable modifiers follow recovered consumers |
| Same-map Teleport artwork              | Four 80 ms frames; separate 600 ms travel recovery                                 |
| Field brightness transition            | Separate 600 ms leaving/reveal clocks                                              |

Death, transitions, modal/carry owners and pending transactions block competing new gameplay intent. Existing gravity/inertia may settle. Editors consume their own keys, composition and repeats. Presentation clocks do not create extra gameplay updates. See [integration ownership](reconstruction-contract.md).

## Offline first-job advancement correction

The implemented Dark Lord beginner-to-thief route uses the authorized Cosmic script, its qualification/reward rules and atomic local publication. These are server-reference policies, not recovered Nexon rules. Unsupported advanced/custom quest dependencies fail before publication.

<details>
<summary>Exact source, transaction and retained replay evidence</summary>

The bounded NPC compiler now admits the complete authored Dark Lord script
`scripts/npc/1052001.js`, including its literal dialogue-state record, lazy branches
and numeric `parseInt` calls. Literal, nonescaping record fields become separate
scalar VM bindings; this does not introduce object reflection or execute Java.
An exact `Java.type('constants.game.GameConstants')` binding can supply the pure
`getHallOfFameMapid`, `getSkillBook`, `isCygnus` and `isAran` operations locally.
Character job access uses the saved scalar job identity. Unknown host methods
remain unsupported.

The authorized `MapleStory-Server` tree supplies the **server-reference** rules:
`AbstractPlayerInteraction.java:1149–1191` owns first-job stat predicates and
requirement labels; `NPCConversationManager.java:363–380` delegates job/reset
mutations; `Character.java:1141–1259,7914–7964,9157–9191` owns first-job rewards,
starter redistribution and inventory expansion. Conversion retains the source
hashes and reads the actual `USE_AUTOASSIGN_STARTERS_AP`,
`USE_STARTING_AP_4` and `USE_ENFORCE_JOB_SP_RANGE` settings. With the supplied
autoassignment setting enabled, the authored predicate deliberately does not
require preallocated DEX25: Dark Lord still requires level10, then redistribution
requires sufficient total AP and sets DEX25/STR4/INT4/LUK4. With autoassignment
disabled, DEX24 is refused and the ordinary DEX25 boundary is eligible.

First explorer job changes100/200/300/400/500 run in the existing atomic profile
transaction, not a development editor or remote service. The thief flow checks
its authored use-item capacity and **both equipment grants together**, changes
job0→400, grants500 stars2070015 and weapons1472061/1332063, adds one SP,
redistributes starter AP without creating AP, and applies the reference
inclusive HP100–150/MP25–50 gains through shared vital recomposition. Eligible
inventory categories gain four slots only where the reference96-slot limit
allows the entire row. Starter reset restores the reference first-job SP
entitlement for delayed advancement. Already learned beginner skills are retained;
catalog membership does not automatically learn thief skills. Equipment instance
creation, original upgrade metadata, UID ownership and item uniqueness remain
under the existing inventory authority. Failure in any reward, stat validation or
durable commit publishes none of that turn's job/stat/item changes.

Original `Skill.wz:400.img/skill/4000000` and the retained numeric book400 establish
the thief skill-book identity; existing executable-backed skill allocation
consumers remain authoritative for learning. They do **not** establish Nexon's
advancement eligibility or reward formulas. The Windows runtime remains unavailable.
Hall-of-Fame PlayerNPC and party-quest progress calls are explicit unavailable
services. `cm.canSpawnPlayerNpc` is a local read that is false below the
reference class cap (`Character.getMaxClassLevel`: Cygnus 120, otherwise 200),
so instructors reach their job dialogue; at the cap it still traps as
`hall-of-fame-player-npc`. The 2nd-job server-custom quests 100000–100011
(instructor letters, test entry and proof; `client/src/quests/custom-quests.js`)
are state-only: they live in `profile.quests` like Cosmic's queststatus rows,
with no record, mob counters, rewards or journal entry, so existing saves need
no migration. Other source quests absent from the original Quest Check
inventory (for example the 3rd-job 100200 family) remain explicit lazy
`custom-quest-progress` traps: a reached call fails the whole turn, rather than
fabricating quest records or blocking an unrelated beginner branch.
Explorer 2nd-job changes (110/120/130, 210/220/230, 310/320, 410/420, 510/520)
use the same transaction from exactly their level-30 first job: one SP into
the new job's pool (`skillPointPool`, pool 1), 5 AP only with
`USE_STARTING_AP_4`, +4 slots for the four item categories, and the reference
`changeJob` HP300–350 (warriors), MP450–500 (magicians) or HP300–350/MP150–200
(others). 3rd/4th-job and any other transition is refused without changing the
draft's published state.

The explorer job-test maps 108000100/200/300/400 are already in the strict
route closure with their inside instructors 1072006/1072005/1072004/1072007,
their test mobs (9000001/2, 9000100/1, 9000200/1, 9000300/1) and those mobs'
supported Dark Marble 4031013 rows (`152-drop-data.sql`, 70%, no quest gate);
`server/test/second-job-content.test.js` checks the packaged catalog. The
compiled NPC programs change, so a catalog extracted before these commits still
carries the old traps/blockers until extraction is re-run. The pirate test rooms
108000501/108000502 are not packaged: Kyrin's warp there sits behind his
`field-population` and `event-instance` traps.

Kyrin's `scripts/npc/1090000.js` uses the same first-job transaction for job0→500
(DEX20, gun1492000, knuckle1482000, bullets2330000×1000). Its other branches
need server state OpenMS does not own, so they compile to the same lazy traps:
`event-instance` (`getEventInstance`, `getEventManager` and calls on its result),
`quest-info-progress` (`getQuestProgressInt`, `setQuestProgress`), `skill-grant`
(`teachSkill`), `field-population` (`getPlayerCount`) and `random-outcome`
(`Math.random()` comparisons). A comparison against one of these values traps
before its other operand is lowered, and an `if` whose test traps compiles to
that trap without lowering either branch. Focused regression source is
`client/test/npc-pirate-advancement.test.js`.

Focused regression source is `client/test/npc-thief-advancement.test.js`, with
the retained complete authored script and source hash in its JSON fixture.
The focused Bun run passes **5 tests / 50 assertions**, including the actual
authored first-job transaction and its eligibility/capacity/commit-failure refusals.
The executed native `offline-thief-advancement` scenario seeds qualification
explicitly, uses the real Dark Lord buttons, allocates the earned SP through the
original Skill control, and compares job/stats/items/skills after reload.
The separate [stopped-origin replay](native-ui-validation/gameplay-authority/stopped-origin/report.json)
also completes the transaction, learns Nimble Body and cold-reloads after the
actual delivery server is stopped. Its original destination and thief-artwork
closure was warmed first; this is not a complete-release offline installation.
Exact identities and qualification boundaries are retained in
[integrated validation](archive/validation-history.md#exercised-gameplay-and-development-controls).

</details>

## Evidence boundary

The [current validation index](validation.md) links scoped reports by source identity. [Earlier gameplay reports](archive/gameplay-history.md) retain old failures, controller counts and performance measurements as historical evidence. Their original measured builds are not silently updated by this guide.

The original input tree contains WZ archives and executables/DLLs, not original C/C++ source. Cosmic is an authorized server emulator reference; no third-party client implementation is used. [Input provenance](inputs.md) and [Windows reference gaps](windows-reference-captures.md) state the remaining boundaries.
