# Original quest data and historical local authority

> [!NOTE]
> The local quest authority described below belonged to the removed client. The extracted records and presentation evidence remain relevant; current quest transactions are server-owned and summarized in [online feature coverage](server/offline-parity.md).

## Scope and ownership

`client/tools/quest-data.js` extracts the supplied Quest archive into `catalog.quests`; `quest-system.js` interprets admitted declarative paths against the shared schema-5 `ProfileStore`. `npc-interactions.js` routes live NPC interaction to that quest menu, an admitted authored Cosmic script, or an authored SQL shop endpoint. `quest-ui.js` owns UtilDlgEx quest dialogue; `ui-quest-window.js` owns the original Quest journal and attached detail, while `ui-quest-alarm.js` owns QuestAlarm.

This is **local authority**, not a live network service or original server parity. Original EXE/WZ/DLL evidence defines presentation, input, resource identities and encoded quest content. Authorized Cosmic GMSv83 supplies server semantics, actual script bodies, shops and supported drop rows; it is neither an alternative client presentation source nor original Nexon server code. Browser persistence and bounded interpretation are local policy. Level progression uses the original client EXP table and Cosmic level-up HP/MP rules ([level progression](character-gameplay-corrections.md#level-progression)). Missing script bodies, unavailable dependencies and unsupported mandatory controls fail closed; no replacement NPC speech or fixture script is invented.

## Complete original archive inventory

A bounded read of every IMG in the supplied v83 `Quest.wz` parsed 156,338 nodes with zero unknown parser types or parse failures:

| IMG | Quest/root records | Nodes | Bytes | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| Check.img | 2,806 | 55,421 | 684,779 | `0603293c5453cb1bcff410dcbd39883ff9b9a70f878956f613a10067c1a153fc` |
| Act.img | 2,823 | 38,132 | 640,726 | `82ca8469fa757328cbe16811c8963b0aca52d61bf44138a27996a38579128da8` |
| Say.img | 2,800 | 42,293 | 3,164,451 | `8199cf01c4b226142c7f18c0175b267801ebd011037a67c0bf1607effe6296a3` |
| QuestInfo.img | 2,817 | 20,018 | 1,474,669 | `59edc9d73ebe3ff2234f6a5329dd26659da579f1f5cc6feaf38cce871dc4e901` |
| Exclusive.img | 1 medal container | 16 | 173 | `0e42a1f3e737e051bae449eb7a007e1555ec64dabb8697201a1adf10893bb18f` |
| PQuest.img | 10 | 458 | 6,521 | `c99d280728d88777ad7890d5d2f1ac2cf5e9d3db2488489f987b77a1343db6d4` |

The extraction uses the existing WZ parser, not a second decoder. The normal extraction context retains actual IMG identities and checksums in the release manifest. The catalog retains each original node's exact path, type, value and classification under `quests.inventory[image].rows`; property containers, malformed authored keys, missing stages, extra numeric branches and auxiliary records are not flattened away. `quests.fields` counts every normalized field path and its observed classifications. `quests.records` is the union of ordinary Check/Act/Say/QuestInfo IDs, not a hand-selected list. The source inventory contains 2,825 distinct ordinary IDs; 2,780 have all four records and 2,779 have both stages in all stage-bearing images.

The complete discovery inventory identified 40 named Check condition families. There are 319 `startscript` and 362 `endscript` Check occurrences. These are references, not bodies. `Etc/ScriptInfo.img` is menu-label/description metadata, not executable quest logic.

## Retained executable evidence

`docs/tools/questConsumers.java` searches PUSH operands for the original decoded string-pool IDs 3198–3232, then exports containing functions without modifying the original program. Its completed read-only Ghidra run retained 53 scalar reference rows in `docs/ghidra-ingame-quests/refs.txt` and the associated decompilations. `evaluate.c.txt` additionally retains the original active-quest evaluator and callers. The existing decoded pool is `docs/ghidra-client/decoded-strings.txt`.

| Address | Evidence used |
| --- | --- |
| `0071d8df`, pool `00b19cdc` | Original Check image/resource consumer. |
| `0071e1d6` | Decodes condition records, including npc, job lists, level/fame/meso fields, quest state and item/mob pairs. |
| `0071e9a1` / `0071ea08` / `0071ea6f` | `lvmin`, `lvmax`, `pop`; fields stored at record offsets `+0x1c`, `+0x20`, `+0x24`. |
| `0071f7fb` | Literal Check job-list loader; entries are enumerated, not inferred from quest names. |
| `0071faa7` and `0071fcf0` | Missing quest `state` and item `count` decode with zero defaults. |
| `00721d2c` | Active quest evaluation: nonzero endpoint NPC mismatch rejects; item and prerequisite-state checks; authored kill counters. |
| `00721d2c`, retained lines 130–163 | Positive item count requires at least that count, negative count imposes a maximum of its absolute value, zero requires absence. Local conditions aggregate owned schema-5 instances; native possession/category semantics beyond the supported projection remain separate. |
| `00721d2c`, retained lines 166–191 | Prerequisite state 0 is neither active nor completed, 1 active, 2 completed. |
| `00721d2c`, retained lines 195–238 | Completion reads encoded three-digit kill counters and compares them with authored required counts. Local storage uses bounded numeric counters instead of recreating a server string format. |
| `007166b6`, `00716926` | Act item presentation/filtering; job mask tests `1 << ((job / 100) & 31)`, with family 9 exemption; gender default 2 means unrestricted. Restricted-gender declarative rewards remain blocked by this interpreter even though schema 5 now stores character gender. |
| `0071808a` | Original completion reward/selection presentation, item/meso/EXP/fame display and selected-item result. |
| `00716fe1`, `007171ba` | Loads dialogue from `Quest/Say.img`, quest ID and stage. |
| `00717740`, `00717963`, `00717434` ([retained](ghidra-quests/zero-page-say.txt)) | An empty page list returns 1 without a dialog; the caller then sends the start/complete action (opcode `0x6b`, action 1/2). |
| `00717963`, `007179e9` | Numeric dialogue sequence with `stop/<page>/<selected-choice>` branch lookup. |
| `00717ddd`–`00717e2a` | Nonempty selected stop text is displayed and terminates the conversation; absent/empty selected stop text advances. Thus a naive `answer - 1` evaluator is not used. `answer` metadata remains in the inventory/projection. |
| `00717b36` | `flip` activates an additional native text/speaker presentation path. That path remains unsupported; it is not guessed from the field name. |
| pool `00b19c34`, `00b19c0c`, `00b19be8` | Original UtilDlgEx quest accept/give-up/list resource identities. Positioning and text metrics are not established by these string references. |

Original packet delivery, authorization, rollback/error behavior, reward generation, repeat policy and time control are not recovered from presentation consumers. The browser transaction policy below is explicitly local.

## Field classification and implemented projections

Every classification is recorded per source node, with an exact source-path reason for unsupported nodes. A quest with an unsupported mandatory condition/action/control or dialogue branch is not admitted. Missing Check/Act/Say stages are explicit blockers. A present Say stage with no numeric pages is admitted: the [original presentation](ghidra-quests/zero-page-say.txt) collects pages in `00717740`/`00717963`, returns 1 for an empty list (`0071794f`/`00718070`) and `00717434` then sends the start/complete action without a dialog. The online authority therefore commits such a stage when it is selected from the NPC menu or Medal window, inside that selecting operation; a stage that offers a reward choice keeps its confirmation for the `0071808a` selection. An absent Say stage follows a caller argument at `0071736c` and stays blocked. Original Act-embedded strings are retained but never substituted: an empty Say stage whose Act stage carries numeric text stays blocked (quest 1029, for example, contains Korean Act text alongside distinct English Say text). Completion stages carrying only `stop` text, such as 1037 stage 1, are the authored no-speech shape.

### Check

Implemented:

- `npc`: required endpoint identity when nonzero; rechecked for every transaction.
- `lvmin`, `lvmax`: inclusive local level gates; zero means no bound.
- `job`: membership in the exact authored list; no implicit inclusion of beginners and no class-family expansion.
- `pop`, `endmeso`: minimum local fame/meso gates.
- `item/<index>/{id,count}`: aggregate local stock with the original positive/negative/zero comparison described above; equipped possession counts for conditions, but quest actions do not silently remove equipped objects.
- `quest/<index>/{id,state}`: exact not-started/active/completed prerequisite state.
- `mob/<index>/{id,count}`: accepted local kills while the quest is active, saturating at the largest requirement for that quest/template. Duplicate requirement rows cannot double-credit a kill.

Explicitly unavailable Check families:

- Time/schedule: `start`, `end`, `interval`, `dayByDay`, `dayOfWeek` and weekday children.
- Declarative scripts/control: `startscript`, `endscript`, `normalAutoStart`, `userInteract`. A supported NPC script route is separate authority, not blanket support for these quest fields.
- Additional character/world conditions not implemented by this interpreter: `level` (distinct from `lvmin/lvmax`), `worldmin`, `worldmax`, `skill`, `pet`, `mbcard`, `mbmin`, `pettamenessmin`, `tamingmoblevelmin`, `petRecallLimit`, `petAutoSpeakingLimit`. Owning skills or Monster Book cards in schema 5 does not by itself implement these Check semantics.
- Field/equipment/info conditions requiring additional semantics: `fieldEnter`, `equipAllNeed`, `equipSelectNeed`, `infoNumber`, `infoex` including `value/cond`, `info`.
- Buff/special conditions: `buff`, `exceptbuff`, `morph`, `partyQuest_S`, `questComplete`.
- Additional nested numeric quest/mob branches and any unrecognized shape/value.

### Act

Implemented local atomic transactions:

- `exp`, `money`, `pop`: original integer quantities; EXP uses the shared `awardExperience` policy, never a quest-specific level-up formula.
- `item/<index>/{id,count}`: positive grants, negative debits, zero no change. All debits are validated against pre-transaction inventory; receiving the same item in the transaction cannot fund its debit.
- `item/job`: original integer family-mask filtering. Unrestricted `gender=2` is supported; restricted-gender rules remain outside the admitted declarative subset, despite the current saved gender field.
- Absent `prop`: unconditional item entry. `prop=0`: no grant. `prop=-1`: an explicit player-selected original reward; selection is mandatory and validated. Positive integer weights select exactly one job-eligible row using the authorized **Cosmic server-reference** `ItemAction.java:96–125` cumulative-weight policy. One injected gameplay RNG sample is consumed inside the accepted profile transaction, never during dialogue/readiness inspection; the selected row is reused for debit/grant validation and durable publication. Original WZ supplies weights and rewards, not recovered Nexon server RNG authority. Nonpositive quantities on choice/weighted grants, fractional weights and totals outside the server signed-integer range remain unavailable.
- `quest/<index>/{id,state}`: encoded state assignments, subject to the local monotonic one-shot constraint. An action attempting to reset a completed/active quest or contradict the current transaction is rejected atomically.
- `npc`, `lvmin`, `lvmax`, `job` list: additional local gates, never job-advancement assignments.
- `nextQuest`: retained, displayed as the original next quest, and available through its original endpoint/prerequisites. It does not silently accept a quest or invent travel.

Unavailable actions: item `var`, restricted `gender`, `period`, `dateExpire`, `name`; skill/rank/master-level actions, pet actions, field/map travel actions, time/control fields, `buffItemID`, `npcAct`, `info`, `message` and unrecognized fields. Embedded numeric/yes/no/ask/stop dialogue is retained as non-operative Act metadata; original Say is the displayed source.

### Say and QuestInfo

Supported Say is ordered numeric pages, authored `yes`/`no` pages, ordinary `stop/npc|item|mob|quest|default` pages, and numeric choice-response branches. Choice IDs are the literal `#L<id>#` values, not option array positions. Missing closing `#l` before another option or the end of text is rendered without inventing another choice. Every displayed answer is one of the encoded choices. A wrong authored stop response terminates without state/reward mutation. A correct path advances to the next numeric page. `ask` is retained, and NPC speaker overrides use the corresponding original String name.

Optional `lost`/`lost/yes` recovery branches are individually classified unavailable and are not offered. They do not prohibit an otherwise supported normal accept/complete path. The runtime does not fake lost-item recovery grants. Nonzero `flip`, malformed authored dialogue keys, nested stop/stop branches, override job/quest/info state, choice-bearing yes/no paths, or choices without a corresponding original result container block affected ordinary dialogue rules.

QuestInfo numeric 0/1/2 journal text and `name`, `area`, `parent`, `order`, `summary`, `demandSummary`, `rewardSummary`, `type`, `sortkey`, `showLayerTag`, `medalCategory` and `viewMedalItem` are retained as presentation. Valid medal category/item metadata feeds Title but does not grant an item. `autoStart`, `autoPreComplete`, `autoComplete`, `autoAccept`, `oneShot`, timers/play-time, selected mob/skill, other selection controls and the nested `8833/4963` record remain mandatory-control blockers. Exclusive medal and PQuest result/rank trees remain unavailable as ordinary quest authority.

## Shared state and transaction ordering

`QuestSystem` owns endpoint/status lookup, dialogue authorization, asynchronous acceptance/completion, give-up, tracker changes and medal challenge/claim routing. The shared profile is the only durable owner. Missing quest records mean state 0; acceptance moves 0→1 and initializes kill counters; completion moves 1→2. Completed quests cannot grant another ordinary completion reward. Optional `completedAt` is epoch milliseconds.

For acceptance/completion, `commitProfile` acquires the profile exclusion and supplies an isolated draft after earlier saves drain. Inside that lock the quest owner rechecks current state, endpoint, all supported Check/Act gates and the exact authorized choice-bearing session. Required debits use pre-transaction stock; selected rewards must be encoded original choices. The transaction applies instance-aware inventory changes, meso/fame, progression and quest state together; completion also removes the tracked quest ID. Whole-profile validation and durable completion precede publication of UI, reward and QuestClear/LevelUp effects. Failure cannot publish part of the reward.

Accepted field deaths use `applyKill(draft, templateId)` inside the field owner's successful death checkpoint, not an independent quest write. It saturates active counters and cannot double-credit duplicate authored requirement rows. Profile roots and nested collections are reacquired after atomic transitions/reset. Save errors remain visible; successful local effects are not advertised before their durable transaction completes.

## Authored NPC scripts and shops

The verified packaged server-reference dataset contains NPC routes, bounded compiled script programs and original SQL shop rows. Routing preserves numeric special-route precedence, the authored name override and deterministic standard-shop fallback. NPCs with quest endpoints present the quest menu with a separate talk route where one exists. Unsupported routes expose their blockers rather than evaluating arbitrary downloaded JavaScript.

The “etc” heading and NPC-name choice are an original **route selector**, not evidence that a second conversation is already active. Retained `ghidra-ingame-quests/006d3392.c.txt` appends `list2` only for nonempty talk text at `006d3a21`, consults `Etc/ScriptInfo.img` at `006d3a65`–`006d3b8b`, falls back when that label is empty (retained lines628–631), and formats the separate option using string-pool3195 at `006d3bea`–`006d3c05`. Selection beyond the quest-ID list sends the talk request at `006d3ef9`–`006d3f4d`; it does not treat the generic row as quest completion. The decoded resources are pool3194 `UI/UIWindow.img/UtilDlgEx/list2`,3195 `#d#L%d# %s#l#k\r\n` and3196 `Etc/ScriptInfo.img` in `ghidra-client/decoded-strings.txt`. This establishes the original selector, not original server script semantics.

That selector is conditional on real quest choices. The later empty-quest-list branch at `006d3d17`–`006d3d6b` sends the NPC talk request directly instead of showing the previously assembled `list2` text. Initial native clicks already use that direct route when no eligible quest exists. The retained quest panel now follows the same rule when its last quest disappears after completion: it transfers directly to authored dialogue, never an ETC-only/name-only menu. Handoff is deferred until panel registration and cancelled on teardown; a refused transfer remains in the native error area with an OK retry, without automatically retrying or inventing a route. Menus with actual quest choices retain their headings and separate talk entry.

Local talk handoff now retains the quest menu until an admitted authored callback supplies its replacement. Previously `startRoute()` closed UtilDlgEx **before** checking the route or its dependencies; a visible but unsupported route therefore erased the conversation and left only a status error. Refusal now returns its reason to the existing native dialog error area, preserving the quest rows and NPC lease. Duplicate clicks and user Close are suspended during the handoff; internal successful replacement remains permitted. A failed initial VM turn never becomes the active session. Supported script, shop and storage routes retain their own destination ownership, and an authored initial disposal may still legitimately close the conversation. No NPC-name row is synthesized when neither a route nor a quest entry exists, and supported talk is not blanket-hidden.

The historical mixed-menu replay used **Robin2003**, map50000 and quest1036 to exercise the separate “etc” route and authored dialogue. Its profile values were explicit setup, not evidence of acquisition. Current route and callback regressions live with the server interaction tests; the removed local-session test is not a current validation command.

The executed `npc-default-dialogue` native scenario seeds only Robin's active quest1036, answers its original quiz through pointer input, accepts completion, then checks that the last-quest transition and subsequent world click both enter authored topics directly. The existing `npc-talk-menu` scenario intentionally retains its quest1036-plus-talk selector assertion; it is not a default-only case. Both passed native replay. [Integrated validation](archive/validation-history.md#exercised-gameplay-and-development-controls) also records the original shop portrait/name presentation and exact build identity.

Shop name presentation is distinct from player trading. Direct original `String.wz:Npc.img` inspection returns clean literal names (`11000/name=Sid`, `1001000/name=Silver`, `1011000/name=Karl`, `1021000/name=River`), with `func=Weapon Seller` stored separately. `UI.wz:UIWindow.img/Shop/backgrnd` is463×339 and its portrait pane ends at y84; the prior browser-only name at y79 with a14px line crossed this border. Retained `ghidra-client-features/dialogs/shop-range5-instructions.txt` shows shop constructor `007532ce`, NPC action composition `00754860` (anchor pushes y76/x56 at `007549d7`/`007549da`), and draw `00754da0` calling buy rows `00754e78`, sell rows `0075577a` and balance `00755e72`. These recovered shop consumers do not draw an NPC-name label. The unsupported visible overlay is removed rather than assigning it another invented font/position; the unchanged original name identifies the accessible portrait group. Original NPC artwork is not resized or reflowed. `ui-trading-room.js` instead labels two player profiles, with no NPC name input; its recovered player-name labels are intentionally unchanged. The executed `npc-shop-name` replay opens Natasha1001001 in104000001; its screenshot confirms the original portrait stays inside the pane without the stray label, and its accessible identity retains Natasha.

`NpcScriptSession` owns one admitted program, session/revision, VM continuation and live-NPC lease. It validates response shape and original dialog type, executes a turn on detached data, and validates all dependencies. A turn with effects is reexecuted against the locked `commitProfile` draft using the same request/time: its preview cannot authorize a later profile. Only durable success publishes the continuation, next view and effects. Read-only turns do not create a save. Closing a session discards its continuation, not already committed earlier turns; pending durable work retains its lease until completion.

`cm.getPlayer().setCS(boolean)` and `getCS()` use Cosmic's conversation-local **chaos-scroll crafting flag**, not a cash-shop flag or currency mutation (`AbstractPlayerInteraction`103–108; `NPCScriptManager`183). A failed turn rolls back the flag with its continuation; disposal/new conversation resets it and no `CS` field is saved. Extraction pins and hashes `USE_ENHANCED_CRAFTING:false`; supported deterministic crafting uses original item-template stats/slots through the existing item authority. Random/enhanced/custom overloads remain refused, not approximated.

Compiler admission supports bounded array tests, guarded counter loops and conservatively proven nested/scalar dependencies and item markup. Original Vicious1012002 is now admitted, along with1022003,2040014 and9201095. Executing Vicious's original bow branch with1000mesos,5 Processed Wood and30 Blue Snail Shells first failed an injected revision boundary without any debit/grant, then succeeded once:200mesos, no ingredients, War Bow1452002 with original PAD25/seven slots, unchanged cash and no persisted CS flag. Fixture ingredients/funds are setup, not acquisition. Other unsupported authored branches remain explicit.

The native script surface supports admitted say/Next/Previous, choice, yes/no and number variants with original controls, markup and NPC portraits. Implemented text/artwork machinery is not proof of a reachable authored route. The [first-pass NPC report](native-ui-validation/npc-quest/report.json) found supported packaged numeric routes requiring say, choice, yes/no and number, but no compatible supported text-input or special-artwork route. It exercised Spiruna's actual number/confirmation refinement using explicitly supplied ore, meso and prerequisite state; neither those fixtures nor a renderer capability demonstrate native acquisition or all dialog variants.

Previous follows the authored callback, not a synthetic page history. Casey **1012008** Ready→fee Previous returned the original fee text in that report; fee→Previous instead retained the page with “NPC callback produced no view and did not dispose.” That branch depends on the authored selection/status callback. Cloy **1012005** terminal Back closes because the authored status branch disposes before sending another page. These are accounted authored-route limitations, not established VM defects or claimed working Back paths.

`NpcShop` provides original buy/sell/recharge selection and native quantity/confirmation prompts. It rechecks live ownership, funds/capacity and the selected instance/quote after the prompt, then repeats validation inside the atomic draft before applying stock and currency changes. Cancel never enters the transaction; closing cannot interrupt a commit. The retained [shop replay](native-ui-validation/npc-quest/shop-verified.json) and [recharge replay](native-ui-validation/npc-quest/shop-recharge-confirmed.json) cover Mina's actual shop: buy two Red Potions for 100 mesos, sell one for 25, and recharge Subi100→500 for 125 mesos, with explicit starting-stock fixtures.

## Native surface and interaction authority

Main wires:

- `NpcInteractions` and `hooks.onNpcDialogue` select the admitted script or ordinary quest dialogue for the current NPC lease.
- `hooks.onQuestJournal` mounts the original Quest window and attached detail.
- accepted death drafts feed `quests.applyKill`, and deferred profile progress feeds automatic helper registration.
- quest change/reward hooks refresh current profile projections after successful publication.

The life owner's native record carries **`canInteract(): boolean`**, not a second admission alias. Quest UI rechecks that exact live closure before opening a conversation, advancing/answering, or committing acceptance/completion. A missing closure, stale field/membership, hidden/unresident/destroyed NPC, absent rendered artwork, dead player or blocking transition cannot authorize the transaction. Normal agent interaction and primary-left world release share this gate; inspector selection never authorizes gameplay. Recovered `00531b8d` cursor and `0094fa8e` left-button release both use NPC pool picker `006d92d3`; `006d3fde` translates dc without facing, with per-edge defaults `[-22,-65,22,0]` from `006dd584`–`006dd6f0`. The former guessed 120×100 proximity policy is removed; original server distance acceptance is not claimed. See [NPC world target and admission](ingame-life.md#npc-world-target-and-admission) for the optional unrendered quest-indicator boundary and retained original evidence.

Integration supplies `LifeSystem.hooks.isBlocked(id)` for map/profile transitions, carried UI state and unrelated modals. It permits the currently open same-NPC dialogue's own continuation check. New cursor/world/normal-agent admission instead calls the same hook **without an ID**, rejecting every modal, including the current conversation. The main UI also prevents new world pointer/cursor activity behind modals. A rejected world action never falls back to metadata inspection.

UtilDlgEx retains original chrome and authored Previous/Next/Yes/No/OK/Close controls, with a bounded scrolling dialogue/menu body. Owned controls/listeners are released with the panel; no overlay authorizes the field behind a modal. Dialogue text uses the shared NPC markup renderer and original name/resource lookup, not HTML evaluation or guessed script control. Missing artwork and unsupported required markup remain dependency/admission boundaries.

NPC quest menus group completable, available, in-progress and other entries with original `UtilDlgEx/list3`, `list1`, `list0` and `list2` headings, following the append order in006d3392. [The recovery procedure](native-ui-authority-recovery.md) records the authored ScriptInfo labels and online menu repair. Incomplete active quests remain visible. A final plain acceptance page presents Accept/Decline directly; earlier narrative pages use Next, Back is available only for a real preceding page, and choice-bearing pages still require their authored choice. Semantic render keys retain unchanged chrome, prose, scrollbars and portrait leases across unrelated saves. Item icons reserve their original dimensions and keep separately rendered item-name text.

The original dialogue palette is not uniformly white: ordinary body text is black; markup retains red, blue and green `#00ff00`. [Exact font instructions](ghidra-client-features/dialogs/dialog-core-instructions.txt) include black `009a3352`, red `009a3460`, blue `009a3674` and green ARGB`ff00ff00` at `009a356a/009a35e6`. NPC name-bar text remains separately recovered white Arial12. World marker updates belong only to the life subsystem, eliminating double advancement from the integrator.

### Journal, helper and medals

The original Quest window has Available, In progress and Completed tabs, category/chain lists, a native scrollbar and an attached detail child with independently scrollable text/objective panes. Selection is inspection, not remote acceptance. Available details can mark the authored NPC on WorldMap; that navigation does not teleport the character. In-progress details expose confirmed give-up and helper registration. Give-up removes active state and its helper ID atomically; cancelling the confirmation leaves both unchanged. Completed records retain summaries but cannot be given up or registered as active objectives.

QuestAlarm saves up to five unique tracked IDs and auto/open preferences. Registration requires an active eligible quest with objectives and capacity; manual registration opens it immediately. Automatic registration accepts **partial positive item progress**, not only complete item requirements, without reordering existing entries. Deferred updates maintain its objective text/visibility. IDs1200–1399 and type51 are excluded. Removing an entry suppresses auto-readdition for the current session; minimize is transient. The helper's Close deliberately clears saved IDs and sets `open:false`, unlike temporarily hiding a window. Opening again does not recreate cleared registrations.

Title uses original Basic/Job/General/Challenge/Event presentation and valid `medalCategory`/`viewMedalItem` records. Challenge and claim route through the selected quest's authored endpoint and ordinary dialogue/transaction; no physical NPC spawn is fabricated. Confirmed forfeit uses give-up admission. Basic displays actually owned medals and routes equip through the inventory owner, not an ownership grant. The [first-pass medal lifecycle](native-ui-validation/npc-quest/medal-lifecycle.json) challenged, forfeited, rechallenged and claimed29509 for one1142084 from explicit prerequisite fixtures. Its later Basic-row equip no-op is retained in the report, not silently promoted to a pass; final replay status belongs to [validation](validation.md).

## Concrete generic paths and content boundaries

### Camila 28268

`[Hunt] The Pigs Are Ruining the Produce!` has:

- Start NPC 1012108, exactly 65 authored advanced-job IDs; **job 0 is absent**. There is no lvmin/lvmax field.
- Completion NPC 1012108 and Pig 1210100 ×30.
- Empty acceptance action; completion EXP 600.
- Complete ordinary accept/refuse/progress/finish dialogue and journal text.

No quest-ID branch exists in the interpreter. This path uses the same NPC, literal-job, kill and EXP operations as other admitted records. The beginner bootstrap must not bypass its job list; the explicitly provisional local class selector is separate from quest interpretation.

Camila is at Henesys 100000000, authored life/6 x5036/y−127/fh68. Henesys east00 reaches map100010000 west00, The Hill East of Henesys, which contains 13 original Pig placements. The field owner's explicit local respawn policy makes 30 accepted kills possible; placement metadata alone does not establish original spawn authority. There is no invented Pig loot.

### Other generic records

- 1009, `Rain's Maple Quiz 1`: NPC12101, job0, authored I/K/S/E choices, EXP2 and nextQuest1010. The correct option is ID0, whose stop text is absent; the three wrong original responses are preserved. Its Info has no automation gate. Following quiz records use the same interpreter, not dedicated script code.
- 1036, `Robin the Walking Encyclopedia`: NPC2003, job0, lvmax10, three authored choice questions, EXP40. No automation gate is authored in Info. The original malformed choice closing markup is preserved, not normalized into different choices.
- 2088, `The Reason Behind the Mushroom Studies`: Bruce1012111, lvmin10; 40 Orange Mushroom Caps4000001 and 10 Mushroom Spores4000011, consumed for EXP300 plus25 Red Potions2000000. Instance-aware transactions support this when the items exist. Acquisition can use admitted quest/shop/script grants and supported original-item/Cosmic drop rows; a dependency listing is not proof every prerequisite is currently obtainable.
- 2062, `Mrs. Ming Ming's First Worry`: NPC1012106, lvmin20; original Pig's Ribbon/Slime Bubble/Bubbling's Huge Bubble requirements and debits, EXP3000. Differing quantities in the authored progress dialogue are preserved, not corrected by rewriting NPC speech.

`record.dependencies` retains referenced NPC, monster, item, quest, map and script identities. The release's selected map set is indexed for actual NPC/mob placements with a bound of512 maps. Missing packaged dependencies are exposed; decoded metadata, a supported script/declarative record and an eligible character are three different conditions. [Current packaging](extraction.json) is the publication authority, not the earlier eight-map inventory. Unsupported script references remain blockers for ordinary quest paths even when unrelated NPC scripts are operational.

## Verification ownership

Original-data probing and the two read-only Ghidra exports above are retained evidence. A historical scoped native Bun invocation extracted all2,825 ordinary records and156,338 nodes; **961 records** had supported ordinary declarative paths in that interpreter revision. This historical count excludes profile eligibility/content feasibility and is not the current release acceptance count.

The native invocation observed: beginner job0 rejection for Camila; wrong-NPC rejection; successful generic acceptance; completion rejected at0 and29 Pig kills; completion after30 accepted kills granting the original EXP600; duplicate completion rejected with only one persistence-mark call for the successful completion. Bruce2088 rejected missing items, then consumed40 Caps and10 Spores and left exactly25 Red Potions after the original reward. Rain1009's wrong authored choice left state1 with rejected dialogue; the correct choice path completed forEXP2 and returned nextQuest1010. These were isolated in-memory profile scenarios using real extracted WZ records, not fabricated quest fixtures or a browser/server parity claim.

Main completed release extraction and integrated native acceptance. [Independent combat/quest evidence](offline-validation/combat-quests/evidence.json) records the real NPC/class controls, 30 native Pig kills, completion and one EXP600 reward, then durable reload. Main's native [journal replay](offline-validation/main/journal-after.json) and [detail replay](offline-validation/main/journal-detail-after.json) reopen completed 28268 on the first journal page, show 30/30 and EXP600, and leave duplicate completion disabled. These prove that supported local path, not every record's content feasibility or original server parity. The earlier persistent-Eval cross-module Object-realm issue was isolated by the native Bun module-graph invocation; profile validation was not weakened.

The more recent [first-pass native NPC/quest report](native-ui-validation/npc-quest/report.json) records real script menus/number/yes-no, shop buy/sell/recharge/cancel, Bruce acceptance/give-up/completion, journal scrolling, one actual Pig kill advancing a seeded29→30 counter, medal lifecycle and WorldMap marker/navigation evidence. It also records the then-missing helper auto-open and medal equip no-op. The current source implements immediate helper opening; only a report tied to the final source identity can establish its final replay. Explicit fixtures, unavailable text/artwork variants and the Casey/Cloy callback limitations remain visible. No complete quest catalog or Windows-runtime parity claim follows.
