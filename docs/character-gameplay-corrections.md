# Character gameplay corrections

## Feedback and resident appearance updates

Expected server refusals, including `SERVER_BUSY` and `REQUIREMENTS_NOT_MET`, remain visible as gameplay feedback. They do not enter the error journal or trigger the unexpected-error alert. Persistence adapters retain a typed refusal so callers can abort their action without misclassifying it as an exception. Unexpected exceptions still reach the journal.

Full snapshots also publish inventory, level and skill changes. A snapshot for the resident field updates its existing owners without starting the field-loading overlay, including cached equip/unequip and removal of a cursed equipped item. New-field entry retains its preparation screen.

## Earned points

`awardExperience` grants five AP per earned level, with the Cosmic Cygnus bonuses from `Character.levelUp` (lines 6308–6321). It no longer assigns STR, DEX, INT and LUK automatically. EXP thresholds and HP/MP growth follow [level progression](#level-progression).

Non-beginner jobs receive three SP per earned level, following `Character.levelUpGainSp` (6257–6280). Beginners retain the executable-backed entitlement `min(level − 1, 6)` minus learned beginner ranks. The online Skill window now uses that entitlement instead of looking at ordinary SP.

The requested restriction on banking SP is enforced in both allocation and display: ordinary advancement stages use separate positions in the existing ten-element `remainingSp` array: first job 0, second 1, third 2, fourth 3. Evan retains positions 0–9 for its ten books. Only the selected skill's book can spend its own balance, so first-job points cannot purchase second-job skills. Existing legacy pooled SP remains in position 0; its historical earning stage cannot be recovered reliably. No existing balances or allocated stats are rewritten. Advancement-stage separation is the requested application policy, not a claim that the original executable maintained four ordinary wire pools.

## Level progression

[`offline-progression.js`](../client/src/character/offline-progression.js) is the single online/offline path for kill and quest level gains.

**EXP table (original client).** `Maplestory_UNPACKED.exe` (SHA-256 `1198fa57…d4df`) has a static `NEXTLEVEL` initializer at `0078c89c` (`ecx = 0x00bef230`) calling the constructor `0078c8a6`. That constructor first fills formula-derived values and then overwrites every level 1–199 with `mov dword [esi+4*level], imm` stores at `0078c9f1..0078d14e`; `0078d158` stores 0 for level 200. The getter `0078d166` returns `[0x00bef230+4*level]`, clamping level <1 to 1 and returning `0x7fffffff` above 200. `NEXT_LEVEL_EXP` is those 199 immediates, for example 1→2 15, 8→9 840, 29→30 55816, 69→70 1564600, 199→200 1608855764. Cosmic `ExpTable.exp` differs at 62 levels. Most of those differences are 1–3 EXP, but Cosmic also swaps levels 9 and 10 (the client stores 1242 then 1144) and differs substantially at 30, 47, 59, 144, 162, 163 and 198. The client table wins. Reproduce:

```sh
objdump -d --x86-asm-syntax=intel --start-address=0x78c9f1 --stop-address=0x78d166 \
  ../Maplestory-Client/Maplestory_UNPACKED.exe | grep -E 'mov\s+dword ptr \[(esi \+ 0x[0-9a-f]+|edi)\], 0x'
```

`[edi]` at `0078cb8a` is level 51 (`edi = esi+0xcc` from `0078c9cb`). Stored `exp` keeps its existing meaning: progress within the current level, reduced by the threshold on level-up (Cosmic `Character.levelUp` `takeexp`). No migration is needed. A stored value already at or above the new threshold levels on the next EXP award, because the `awardExperience` loop drains every reached threshold.

**HP/MP per level (Cosmic server reference).** The client receives level-up maxima from the server, so it has no growth table. The rules use Cosmic `Character.levelUp` 6323–6371, where `Randomizer.rand(a,b)` is inclusive (`a + floor(r·(b−a+1))`):

| Job (Cosmic `isA`)                       | HP    | MP                                          |
| ---------------------------------------- | ----- | ------------------------------------------- |
| Beginner 0/1000/2000                     | 12–16 | 10–12                                       |
| Warrior, Dawn Warrior                    | 24–28 | 4–6                                         |
| Magician, Blaze Wizard                   | 10–14 | 22–24                                       |
| Bowman, Thief, Wind Archer, Night Walker | 20–24 | 14–16                                       |
| Pirate, Thunder Breaker                  | 22–28 | 18–23                                       |
| Aran                                     | 44–48 | 4–8 (Cosmic `+floor(aids·0.1)` is always 0) |
| GM 9xx                                   | 30000 | 30000                                       |

MP also gains total INT (base plus equipment) divided by 20 for the Magician job style (families 2/12/22) or by 10 otherwise. This uses `config.yaml:226 USE_RANDOMIZE_HPMP_GAIN: true`. Temporary INT buffs are not counted. Learned Improved MaxHP Increase (1000001/11000000/5100000/15100000) and Improved MaxMP Increase (2000001/12000000) add their WZ `x` through `learnedGrowth`. Base maxima stay capped at 30000. The kill path uses `world.random`. The online quest path reads `serverRandomSamples` in order: sample 0 remains the weighted-reward draw. Offline play uses its field/quest random hooks. A level-up without a random source fails closed. Job-advancement HP/MP uses Cosmic `changeJob` 1193–1210 (`jobAdvancementGrowthRange`), shared with the first-job NPC effect.

**One-off recalculation.** `expectedBaseVitals({ job, level, advancements, int, ap, skills }, catalog)` returns the expected `baseMaxHP`/`baseMaxMP` from creation values 50/30. Past rolls are unknown, so every range uses its truncated mean `trunc((min+max)/2)`. Unknown advancement levels default to 8 for Magicians and 10 for other first jobs, then 30, 70 and 120. Growth-skill ranks apply from the level at which they were held. INT defaults to the minimum 4, which gives a lower bound. AP spent on HP/MP is valued at the final job's AssignAP midpoint plus its INT term, without skill `y`. It is a pure function; applying it to stored characters is a separate one-off script.

## Incoming monster hits

The supplied archive was read directly: `Mob.wz:0100100.img/info` gives Snail level 1, PADamage 12 and accuracy 20. These agree with the reusable extracted catalog. The existing `0079286e` physical evasion formula, its 4.5 divisor, integer half-level penalty, and ordinary/thief caps agree with the retained [decompilation](ghidra-client-features/trading/physical-incoming-evasion.txt) and [constant bytes](ghidra-client-features/trading/physical-incoming-evasion-constants.txt).

Fresh [Ghidra instructions](ghidra-client/gameplay-corrections/incoming-instructions.txt) confirm a second reason for MISS: `0095848f` compares the physical result with zero and `00958492 SETLE` marks all nonpositive damage as missed. The later minimum-one branch at `00958fed` only applies when that miss flag is clear. Defense can therefore cause repeated MISS against weak monsters even when evasion probability is low. The reported level-5 beginner's derived EVA 7 against Snail accuracy 20 implies about 7.78% evasion; its PDD 12 can separately reduce every Snail physical damage roll below one. The formula is preserved rather than replacing native defense misses with guaranteed one-damage hits.

## Dark scroll destruction

Direct `Item.wz:Consume/0204.img/02043005/info` observations give 30% success and `cursed: 50`. Curse probability applies after failure, matching the supplied Cosmic `ItemInformationProvider.scrollEquipWithId` (1063–1135). An ordinary failed dark scroll can leave the item intact; a curse removes it. White Scroll preserves a failed upgrade slot but does not protect against curse destruction.

The existing `applyEnhancement` removes the selected UID from its actual container, including worn equipment, and recalculates worn-item vitals. Same-template copies are preserved. Server item rows and their economic ledger follow the committed draft. Pure regression cases cover both containers and White Scroll; native validation below checks the transaction and reconnect boundary.

## Focused checks

- `client/test/level-points.test.js`: multilevel awards, job-stage isolation, beginner entitlement, Cygnus boundaries and the level cap.
- `client/test/online-feedback.test.js`: visible refusals, unexpected-exception routing and online beginner point display.
- Existing skill allocation/growth, advancement, enhancement, physical damage, transport and kill-credit checks cover the affected shared contracts.
- `bun server/tools/check-character-corrections.js --output /tmp/openms-character-corrections`: disposable database/accounts and two isolated browsers; native quest completion, skill allocation, equip/unequip, invalid equipment admission, worn/bag dark scrolling, recipient appearance and reconnect. Original scroll RNG is retained and bounded; exhausting the bound is a failed check, never a manufactured curse. No extraction rebuild is required.

The browser report records source, rules and catalog identities. These checks establish application behavior and source agreement, not original Windows runtime parity.

The retained [native report](validation/character-corrections/report.json) passes with zero loading-overlay activations and no browser exceptions. It includes the rejected equipment requirement, earned and spent second-job SP, two curse deletions, the witness's equipped-weapon removal, and reconnect persistence. Both participants and the reconnected character verified the same served source and asset identity. The focused regression run passed 77 tests; changed JavaScript formatting/lint, the guarded browser build and documentation links also passed.
