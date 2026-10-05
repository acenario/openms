# Original asset implementation evidence

## Scope and provenance

This is a reverse-engineering report, not recovered original source. Only the supplied original PE binaries and original WZ files were examined; no third-party implementation was consulted. Ghidra 12.0.4 headless imported and analyzed NameSpace.dll, Canvas.dll, ResMan.dll, ZLZ.dll, PCOM.dll and Shape2D.dll as `x86:LE:32:default:windows`. PCOM and Shape2D were added when real dependencies led there. No Windows binary was executed.

Ghidra requires Java 21; used `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`. The shipped x86 macOS decompiler stalled during program registration. Removing its quarantine attribute did not resolve it. Main built Ghidra's supplied native decompiler source for ARM64; fresh projects then completed normally. Failed and successful launches remain in the logs.

| Binary | Bytes | Image base | SHA-256 |
|---|---:|---|---|
| NameSpace.dll | 143360 | 50800000 | 7eed6c13a60a99bd3f7c2e22ae4b9f0cdb492361260a81172703f260ab661251 |
| Canvas.dll | 118784 | 50000000 | 9a14ea054cbde05ac42838047bf5057ccf6847ef78a8551da2d0f31cfe1fbb73 |
| ResMan.dll | 49152 | 51000000 | 5e31263f9dbab4b6f161aa85485162d01038bddc859821cafe88ab805530189e |
| ZLZ.dll | 81973 | 10000000 | ce65505fc65b3c03c22db309c66443e9b81fc1aa8e246c3bb4757bdd66a98ce9 |
| PCOM.dll | 114688 | 50c00000 | 917181e24f3b152302f9f93adf4ac3e13baf086a68224d258f47df5bb3862cf1 |
| Shape2D.dll | 86016 | 51400000 | 5e9b27d392b4a373fcb21d8b188c8b6864c1fd60fc33563ae24c782b26d97e43 |

All addresses below are Ghidra virtual addresses in these exact binaries, not file offsets. Ghidra output lives under `docs/ghidra-assets/<binary>/`: `metadata.txt` contains identities and symbols; `strings.txt` contains string addresses and references; `decompiled.c` contains address-delimited decompilation. Targeted files additionally retain byte dumps, xrefs and disassembly. ZLZ's `recovered.c` is important: Ghidra initially omitted a virtual input method, subsequently recovered from the actual vtable at `1000ee64`.

## PKG1 header, directory and version

NameSpace `50811a8c` checks magic `0x31474b50` (bytes `PKG1`), reads low/high size DWORDs and a header-size DWORD, seeks to that header offset, and rejects nonzero high size DWORD. Original `Base.wz` and `TamingMob.wz` both have:

- offset 0: magic;
- offset 4: little-endian 64-bit data length, equal to file length minus 60;
- offset 12: little-endian 32-bit data-start/header length 60;
- offset 16: NUL-terminated copyright text in the remaining header;
- offset 60: bytes `ac 00` followed by the compact directory count at offset 62.

Original Base.wz: 6540 bytes, SHA-256 `83fa0a8c2e11f8cbc4e92f46b5f9e8137fb1d0f7dd4b6cdc7ea337087c854cf4`. TamingMob.wz: 797 bytes, SHA-256 `d23604f70c25cabd83e5c30a2ed9390ba1078c0966fd7d76a4adfc03cb2cae0d`.

`50811a8c` hashes the provided version string with unsigned 32-bit arithmetic:

```
h = 0
for each UTF-16 code unit c: h = h * 32 + c + 1
b = h.byte0 XOR h.byte1 XOR h.byte2 XOR h.byte3
```

It accepts either `b` or `~b` for a stored version byte, selecting a serialization mode accordingly. Decimal string `83` gives `h=0x754`, `b=0x53`, `~b=0xac`. Among integer versions 0..299 this is the sole match to 0xac. Main independently confirmed full directory parsing at version 83; client-analysis worker independently found literal version 0x53 in executable log/resource-mount functions.

Directory routine `50811dd7` reads compact count, then per-entry byte tag, string serialization with a mode selected by `tag < 3`, compact size, compact checksum and transformed offset. It stores `tag & 1` as the directory/object distinction. The routine delegates strings to `5080dce3`, which calls the PCOM serializer. Do not infer additional directory tag layouts solely from generic WZ folklore.

Offset helper `50811ed8`, also retained in `NameSpace.dll/targeted.txt`, is exactly:

```
p = stream.tell()                  // before reading encoded offset
u = (~(p - base) * hash - 0x581c3f6d) mod 2^32
u = rotateLeft32(u, u & 31)
e = readLE32()
result = (e XOR u) + base
```

The internal stream is a header-offset view. The equivalent adaptation to an absolute-file reader, confirmed by Main against complete Base/Map/Character directory trees, is:

```
u = (~(absoluteOffsetFieldPosition - dataStart) * hash - 0x581c3f6d) >>> 0
absoluteTarget = ((readLE32() XOR rotateLeft32(u,u&31)) + 2*dataStart) >>> 0
```

Writer `5081399d` contains the inverse XOR/rotation transformation. Rotation and multiplication must wrap at 32 bits (JS `Math.imul` and unsigned normalization).

## AES stream and strings

Primary trace: PCOM string decoder `50c0707f` -> decrypt wrapper `50c01076` -> key initialization `50c01427` / expansion `50c01442` and IV initialization `50c013e8` -> stream transform `50c02465`, final partial block `50c025bd`. AES encryption core is `50c0156c`; lookup-table generation contains the AES field polynomial 0x1b.

- PCOM IV table: `50c17090`; only its first four bytes, `4d 23 c7 2b`, are used. `50c013e8` copies those same four bytes four times to make a 16-byte state.
- PCOM key table: `50c170b0`. `50c01442` selects DWORD indices 0,4,8,12,16,20,24,28, not eight consecutive DWORDs.
- Effective AES-256 key bytes: `130000000800000006000000b40000001b0000000f0000003300000052000000`.
- Initial state: `4d23c72b4d23c72b4d23c72b4d23c72b`.
- Encrypt the state with AES-256, XOR resulting bytes with input, encrypt the resulting state again for the next 16-byte keystream block. This is OFB-style keystream generation; no padding or ciphertext feedback. Each wrapper call reinitializes the state.
- Matching tables occur at Canvas `50018090`/`500180b0` and ZLZ `10010040`/`10010060`.

`PCOM.dll/targeted.txt` retains actual table bytes, direct xrefs and key-selection assembly. Main's independent original-archive probe produced first keystream block `96ae3fa448fadd904676056197ce7868` and decoded Character's first name to `00002000.img`.

String decoder `50c0707f`:

1. Read signed byte `n`; zero means empty.
2. If negative, byte-string length is `-n`, except -128 means read positive LE int32 length.
3. If positive, UTF-16 code-unit length is `n`, except 127 means read LE int32 length.
4. Original rejects negative extended lengths and lengths above 8191.
5. In encrypted mode, decrypt exactly length bytes for byte strings or twice length for UTF-16 strings with the stream above.
6. Byte string: byte i XOR `(0xaa+i)&255`, then widen to a code unit.
7. UTF-16: LE code unit i XOR `(0xaaaa+i)&65535`.

The DLL also has a non-AES branch applying only the incrementing XOR masks. A path/List.wz-dependent predicate chooses it (`50c06c2d`); do not assume every possible archive mode is encrypted identically. Supplied main archives decoded with the AES mode.

`PcSerializeString` export is `50c06411`. String-reference reader `50c06dac` receives a discriminator: zero means inline string; nonzero means read LE int32 relative offset, seek `stringTableBase+offset`, invoke the decoder and restore the old cursor. It caches strings longer than four code units. For ordinary property strings the observed inline/reference tags are 0/1; object class strings use 0x73/0x1b. `PcSerializeObject` at `50c086ff` explicitly accepts the latter, plus alternate 0x23 and 0x41 branches not required by the exercised archives.

## Properties, object types and links

`PCOM 50c0d939` is the Property serializer: ordinary form has two reserved bytes (writer emits zero), compact int count, then each property name via string-reference serialization and one-byte value tag. A nonzero first reserved byte selects another internal path; not fully characterized.

`50c0d3bf` is the value dispatch. Wire tag 9 is mapped to internal COM variant tag 13. Proven byte consumption:

| Wire tag | Payload |
|---:|---|
| 0 | none/null |
| 2, 11, 16, 17, 18 | two bytes, via `50c0b835` -> `50c0b858` |
| 3 | compact 32-bit signed integer |
| 4 | compact 32-bit float bit pattern, reinterpret as IEEE binary32 |
| 5, 7 | eight bytes, via `50c0b8cf` (double/date variant storage) |
| 6 | compact signed 64-bit value |
| 8 | discriminator + inline/reference string |
| 9 | LE u32 object byte length followed by `PcSerializeObject` |
| 19 | compact 32-bit unsigned variant |

The unusual byte widths above are actual serializer grouping, not generic COM memory-layout assumptions. Common supplied assets exercise 0/2/3/4/5/8/9. Unknown/unsupported tags cause an error, not a guessed skip.

Compact reader `50c0c0af` reads signed byte, returning it unless it is -128, in which case it reads four bytes. `50c0c1ad` does the same but reads eight bytes and sign-extends the short form. This is not a variable-length base-128 integer. Float's common zero byte versus 0x80+raw4 follows from compacting the raw bit pattern.

Resource classes are literal strings instantiated through PCOM, not fixed integer identifiers. Relevant evidence:

- `Property`: PCOM `50c0d90a`/`50c0d939`, literal `50c1732c`.
- `Canvas`: Canvas `50010105`/`50010128`, literal `500182f4`.
- `Shape2D#Vector2D`: Shape2D literal `514114d4`, serializer `5140699f`; reads compact x then compact y through `5140530b`, no intervening header.
- `UOL`: PCOM literal `50c17318`, serializer `50c0ef19`; reads one reserved byte, string discriminator and string-reference link text. It derives the owning property directory by stripping the last slash/backslash component before resolving the target. `50c0f774` normalizes backslashes to slashes (with UNC handling), and `50c0f7be` recognizes rooted/drive paths. Full URL/UNC behavior is not necessary for the relative links exercised here and is not claimed reproduced.
  - The PCOM.dll UOL target builder is `50c0f3e7`, which goes through `50c0fca8` to the text join `50c0fd6f`. One original Npc.wz frame resolves to nothing: `2111000.img` `say/14 = ../4` becomes the absent `Npc/2111000.img/4`. Of 3,596 Npc.wz `say` UOLs, it is the only one that fails. Preflight records it as normalization `dangling-npc-frame-uol`, and extraction omits that frame, so `say` keeps frames 0–13. The rule matches only this exact image sha256, field and raw value (`client/tools/life-data.js`). How the original client handles a missing frame target at runtime is still unrecovered.
- `Shape2D#Convex2D`: name getter `51401aed` and serializer `5140318b` are adjacent interface slots at `5140c3c8`/`5140c3cc`. Serializer reads a compact count through `51404c3e` -> `5140530b`, then count nested objects through `514047a3`. The nested helper calls `DAT_51411a10`, resolved to `PcSerializeObject` in `51405dac`. There is **no reserved byte before the count and no u32 byte length before each nested object**. Each child starts with its own object class-string tag and payload; Vector2D is one possible child. This was followed after Main encountered an original tile canvas's `foothold` property. `Shape2D.dll/targeted.txt` retains vtable bytes, xrefs and assembly. `Shape2D#PolyShape2D` is also a literal class; its specific dispatch has not been separately established here.

ResMan imports PCOM dynamically: loader references at `510022a2` (PCOM.DLL), `510022f5` (PcSerializeObject), `51002302` (PcSerializeString), `5100230f` (PcRootNameSpace). ResMan's complete decompilation is retained; this investigation makes no additional unsupported claim about cache lifetime or resource fallback precedence.

## Canvas layout and pixels

Canvas deserializer `50010128` (assembly retained) reads:

1. reserved byte;
2. property-present byte; if nonzero invoke ordinary Property serializer;
3. compact int width, compact int height; both at most 65535;
4. compact int pixel format, accepted **only** 1, 2, 513 (0x201), 1026 (0x402);
5. compact int nonnegative scale exponent;
6. four compact ints each required to be zero;
7. length-framed pixel payload: LE u32 byte length, then one zero byte and compressed/encrypted bytes.

The scale field is independent of format. In particular, adding format 513 and scale 4 to call the result "format 517" misrepresents this original implementation.

`50004c14` computes stored dimensions with ceil division by `2^scale`. Pitch is `storedWidth << (format & 31)`: 2 bytes/pixel for 1/513, 4 for 2. Stored rows are `storedHeight`, except 1026 uses rows/4. `50010dc9` loads rows into canvas tile storage and checks exact byte counts. Logical pixel lookup `5000c54e` shifts coordinates by scale before indexing. Thus scale 4 means each stored sample occupies a 16x16 logical region, clipped to logical dimensions.

Pixel conversion evidence:

- **1:** LE 16-bit ARGB4444; memory low nibble B, next G, next R, high A. `500073ef` duplicates each nibble into both halves of its output channel (`n*17`), producing 0xAARRGGBB.
- **2:** 32-bit 0xAARRGGBB, hence byte order BGRA in the file. Preserve straight alpha rather than premultiplying during extraction.
- **513:** opaque RGB565. Original software conversion helper `50007426` uses `R=((p>>11)&31)<<3`, `G=(((p>>5)&63)<<2)|((p>>9)&3)`, `B=((p&31)<<3)|((p>>2)&7)`. **Red's low bits are not replicated**. Both decompilation and instruction-by-instruction assembly confirm this: input 0xffff yields 0xfff8ffff, not 0xffffffff. This describes this helper, not necessarily every GPU hardware conversion route.
- **1026:** block-row storage is proven. Canvas delegates its conversion through an interface near the end of `50010dc9`; a complete block decoder was not established in this DLL. The client/Gr2D evidence worker separately identified the DXT3 mapping in Gr2D at `50404869`; see that worker's report rather than attributing the mapping to Canvas alone.

### Compression framing and the important non-final zlib stream

Canvas `50010dc9` requires the first payload byte to be zero, then invokes wrapper `50011f17` with compressed payload length minus one. That wrapper calls the original ZLZ exports:

- `1000ac50 ZLZCreateDeflator`;
- `1000b410 ZLZCreateInflator`;
- `1000b830 ZLZCloseFilter`.

ZLZ includes original string `inflate 1.1.3 Copyright 1995-1998 Mark Adler` and version `1.1.3`.

For encrypted mode, the recovered input method `1000b550` (vtable entry at `1000ee68`) reads repeated LE u32 chunk lengths followed by that many ciphertext bytes. It invokes `100011c0` with the IV at `10010040` independently per chunk, then supplies the concatenated plaintext to the same zlib inflater. Assembly `1000b5f1` proves the ciphertext read length is the chunk length; Ghidra's decompiler prints an incorrect parameter name for this call. Plain mode supplies zlib bytes directly.

**The original writes Z_SYNC_FLUSH, not necessarily a finalized zlib stream.** `1000b250` calls deflate routine `100047c0` with flush argument **2**, looping while output is full, then flushing buffered bytes. No finish flag 4 is used by this close/flush path. Inflater `1000b550` calls `100075b0` with argument 2 and treats both return 1 (stream end) and -5 (buffer exhaustion) as normal completion, returning produced bytes. Canvas then requires the full requested row length. Consequently a JS decoder should use the equivalent sync-flush finish semantics and require the exact expected decompressed byte count; catching and ignoring arbitrary inflate errors would not reproduce the original contract.

Main exercised this distinction on original Character `stand1/0/body`, 21x31 format 1: a payload beginning `78 9c 8c 93 ed 11...` did not satisfy strict finalized-stream inflate. This is consistent with the explicit original flush semantics, not evidence that the asset should be patched.

## Timed alpha/vector interpolation

The client/Gr2D worker established that frame alpha scheduling in Gr2D `5040b9e7` calls the alpha vector's interface slot `+0x90`. Shape2D supplies the rest of the actual chain:

```
IWzVector2D vtable 5140c0fc, slot +0x90 at 5140c18c
  -> absolute timed move 5140828f
  -> movement constructor 51407fe1 / 5140806d
  -> motion vtable 5140d8fc, evaluator +8
  -> 5140809f
```

`514082de` and `514082e5` subtract current y/x from target y/x to form deltas. For ordinary nonrepeating movement, `5140809f` holds the current value before or at start time, evaluates between endpoints, and applies the complete delta at or after end time. The intermediate operation is **signed integer arithmetic**, not floating-point interpolation:

```
value = startValue + truncTowardZero(delta * (now-startTime) / (endTime-startTime))
```

Assembly at `51408125` uses 32-bit `IMUL`; `5140812e` uses signed `IDIV` (and the y calculation at `51408137`/`5140813c` is identical). At completion the evaluator returns 1; during motion it returns 0. A separately flagged repeating path accumulates deltas across periods; it must not be implicitly enabled for ordinary frame alpha fades. Full vtable bytes, references and assembly are retained in `Shape2D.dll/interpolation.txt`.

## Sound envelope encountered by the full archive sweep

The sweep encountered `Sound_DX8` inside original `Map.wz:MapHelper.img`. Main subsequently ran Ghidra headless on the supplied `Sound_DX8.dll` (base `51800000`, SHA-256 `607a0c5840a2ed7d45236c9446b8b87df35b0c3c5a8f9161c12b80b4442662c9`), project `/tmp/maple-sound-ghidra/sound`. Address-bearing output is in `ghidra-assets/Sound_DX8.dll/`.

`51807041` returns class name `Sound_DX8`; adjacent serializer `518070c0` reads one required-zero byte and three compact integers, storing them at object offsets `+0x2c`, `+0x30`, `+0x34`. The first is the encoded payload byte length. The implementation retains the other two as `field30` and `field34` rather than inventing semantic names.

Format serializer `51807511` reads two 16-byte GUIDs, compact sample-size and flags fields, and another 16-byte format GUID. Unless the last GUID equals all-zero or the original constant at `51819df0` (`d617640f18c3d011a43f00a0c9223196`), it reads a compact format-byte length and that many bytes. The declared audio payload follows. The JavaScript decoder preserves this metadata and encoded payload; it does **not** claim audio decoding/playback.

Original `MapHelper.img` now parses with exact object-boundary checks: `sound1` has 6,162 payload bytes, `field30=1991`, `field34=2`, and 30 format bytes. This removes the sweep's originally observed unsupported-object failure without discarding the object or guessing its length.

## Reproduction and limitations

Analysis tools are retained at `docs/tools/assetExport.java`, `assetInspect.java`, `assetRecover.java`. Successful projects are `/tmp/maple-assets-ghidra/assets3` and `/tmp/maple-pcom-ghidra/pcom3`. Example rerun from the workspace:

```
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
/Users/k/Downloads/ghidra_12.0.4_PUBLIC/support/analyzeHeadless \
/tmp/maple-assets-ghidra assets3 -process Canvas.dll -noanalysis \
-scriptPath docs/tools -postScript assetExport.java docs/ghidra-assets
```

For reproducibility from scratch, import the exact original DLL into a fresh project, run default Ghidra analysis and execute `assetExport.java` afterward. The logs prove successful imports, analysis, script execution and saves. No project-wide build, formatter, linter or test suite was run by this investigation worker. Evidence artifacts are retained rather than throwaway scripts because they support the decoder's provenance.

Unresolved: alternate 0x23/0x41 object forms; nonzero Property header branch; full List.wz mode-selection path policy; specific PolyShape dispatch; full ResMan cache/fallback behavior; whether RGB565 GPU output rounds differently from the proven software helper. Format 1026's DXT3 identification comes from the separate Gr2D investigation, not this DLL's delegated conversion. All decoder behavior beyond the cited recovered branches should be labeled independently verified or unsupported, not attributed to these binaries without a trace.
