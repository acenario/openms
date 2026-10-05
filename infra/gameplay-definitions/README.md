# Gameplay definitions

This directory owns the gameplay script inputs for content compilation. It contains all **1,915 JavaScript files** copied byte-for-byte from the supplied Cosmic `scripts/` tree at revision `fec53bc7714dc0f1ae3f50b2986cdf2727e0912a`. [manifest.json](manifest.json) records the imported paths, byte counts and SHA-256 hashes; [LICENSE](LICENSE) retains the upstream license. The external server checkout is no longer required.

| Directory | Files | Current conversion |
| --- | ---: | --- |
| `npc/` | 708 | Closed NPC compiler; unsupported constructs block their route |
| `portal/` | 458 | Four hash-verified tutorial programs; other scripts inventoried |
| `quest/` | 253 | Inventory |
| `reactor/` | 292 | Inventory |
| `event/` | 108 | Six canonical transport cycles compiled (Boats, Trains, Subway, Cabin, Genie, AirPlane); others inventory |
| `map/` | 90 | Inventory |
| `item/` | 2 | Inventory |
| Root scripts | 4 | Inventory |

The source files are data for the bounded compiler, never directly evaluated as JavaScript. Importing these files does not add runtime support for previously blocked scripts or Java host APIs. Preserve their bytes and copyright notices; they are excluded from application formatting/linting. Generated provenance keeps logical paths such as `scripts/npc/1002000.js`, independently of the physical scripts root.

## Local policy

[policy.json](policy.json) contains only the nine settings consumed by conversion, extracted from the supplied Cosmic configuration (`USE_PARTY_EXP_BONUS` is an OpenMS switch with no Cosmic key). No Java files, Java file hashes, full `config.yaml`, credentials or deployment settings are needed. The converter validates schema version 1 and hashes this small policy file for generated provenance.

| Setting | Imported value | Consumer |
| --- | --- | --- |
| `enhancedCrafting` | `false` | Crafting policy, from `USE_ENHANCED_CRAFTING` |
| `travelRate` | `1` | Transport schedules: `em.getTransportationTime(t)` = `ceil(t / travelRate)` (Cosmic world `travel_rate`). `1` is the authored v83 cadence; larger values shorten every scaled wait |
| `staticConfig.USE_CPQ` | `true` | NPC static branch compilation |
| `staticConfig.USE_ENABLE_SOLO_EXPEDITIONS` | `false` | NPC static branch compilation |
| `staticConfig.USE_AUTOASSIGN_STARTERS_AP` | `true` | NPC static branch compilation |
| `staticConfig.USE_STARTING_AP_4` | `false` | NPC static branch compilation |
| `staticConfig.USE_ENFORCE_JOB_SP_RANGE` | `false` | NPC static branch compilation |
| `staticConfig.USE_PARTY_FOR_STARTERS` | `false` | Published as `catalog.serverData.policy` for the server and browser party rule (`canFormParty`). `true` lets Beginners/Noblesses/Legends below level 10 form parties; see the [party formation gate](../../docs/offline-binding-actions.md) |
| `staticConfig.USE_PARTY_EXP_BONUS` | `true` | OpenMS switch, published as `catalog.serverData.policy` for server kill credit (`planKillCredit`). `true` applies the Cosmic GMSv83 level-weighted party split and per-member party bonus; `false` restores the OpenMS equal split; see [EXP and loot](../../docs/server/remaining-work.md#openms-policies-and-original-evidence) |

Enhanced crafting must remain `false` until its effects are implemented. Equipment random stats remain an explicit unsupported policy (`false`) in the converter. Unknown fields, missing settings and nonboolean settings fail validation rather than selecting implicit defaults.

## Compile and update

```sh
# Compile definitions without WZ files, a database or a server checkout.
bun tools/openms.js data server --output /tmp/openms-gameplay-data

# Build the existing playable content package from original WZ plus local definitions.
bun tools/openms.js extract --assets ../Maplestory-Client
```

Defaults are repository `infra/gameplay-definitions` and [`infra/sql`](../sql/README.md). Override them with `--gameplay-definitions-root DIR` and `--sql-root DIR`; the gameplay definitions root must contain `policy.json` and the category directories directly. The former `--server-reference` and `--server-root` flags are removed. One-shot tools do not use environment variables for configuration.

To update the imported snapshot, copy the intended script files, retain the license and record their actual upstream revision and hashes in the manifest. Review required policy changes separately. Run the scoped converter tests before extracting a new asset build. Script/policy edits invalidate smoke's extraction identity; editing these inputs does not modify an already generated catalog or live database. This relocation changes policy provenance, so a subsequent extraction creates a new content identity even when gameplay definitions are equivalent. Online dialogue execution and durable gameplay decisions remain owned by the OpenMS server.
