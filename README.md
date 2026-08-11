# llm-eval-suite

A Bun/TypeScript CLI that systematically profiles candidate local GGUF models
loaded through [LM Studio](https://lmstudio.ai/) to find the best model and
configuration for pair-programming (sync) vs. overnight autonomous task
execution (async) on hybrid VRAM/RAM hardware.

Target environment: Windows 11, LM Studio's local server on
`http://127.0.0.1:1234`, models managed via the `lms` CLI, and hardware
telemetry sampled through PowerShell (`Get-CimInstance`, `Get-Counter`).

Total VRAM is read from the registry (`HardwareInformation.qwMemorySize`
under each display adapter's driver key), not `Win32_VideoController.AdapterRAM`
— that WMI property is a 32-bit field that caps/wraps at 4GB for any GPU with
more VRAM than that (a well-documented Windows limitation), which silently
reported ~4095MB "total" on a 16GB card and made Phase 3's free-VRAM
guardrail reject every offload level even on a model that was clearly running
fine in VRAM.

GPU **usage** is scoped to the inference engine's own process
(`Get-Process -Name '*llama*'`, matched against `GPU Process Memory(*)`),
not the system-wide `GPU Adapter Memory(*)` counters — confirmed on real
hardware that those sum dedicated GPU usage across *every* process on the
machine, including the Windows kernel process and 30+ ordinary desktop apps
(browser tabs, terminals, Explorer), which made free VRAM come out deeply
negative even at cpu-only GPU offload regardless of the total-VRAM fix above.
This means `dedicatedVramFreeMB` is "headroom if only this model were using
the GPU," not a literal whole-system free figure — a deliberate tradeoff,
since the system-wide figure proved unusable on real hardware with normal
desktop activity running alongside LM Studio.

## How it works

Candidate models are **discovered live** by shelling out to
`lms ls --json --variants` — there is no static config file to keep in sync
with what's actually downloaded. Every downloaded base model becomes a
candidate, using whichever quantization is currently selected for it in LM
Studio, and is pushed through four phases, in order, stopping early the
moment a model is discarded.

> **Why one quantization per model, not every downloaded one:** `lms load`
> and the `/api/v1/models/load` REST endpoint cannot target a specific
> quantization variant — this is a confirmed, currently open upstream
> limitation
> ([lmstudio-ai/lmstudio-bug-tracker#1462](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1462)).
> Both always resolve to whichever variant is marked "selected" for that
> model in the app, regardless of any `@quant` suffix passed in. If a base
> model has more than one quantization downloaded, the suite logs a warning
> naming the ones that will be skipped this run — switch the selected
> variant in LM Studio's UI and re-run to evaluate another one.

1. **Phase 1 — High-Speed Ping Filter**: loads the model at 4096 context and
   requires ≥ 10 tok/sec on a short completion, or it's discarded.
2. **Phase 2 — Capability & Sanity Filter**: loads at 8192 context and
   requires a well-formed, non-repeating JSON tool-call response to an
   AST-parsing prompt. Uses a 1024-token budget rather than a hard 300 —
   reasoning-tuned models (Magistral, Qwen3-thinking variants, ...) commonly
   emit a chain-of-thought preamble before their real answer, and 300 tokens
   was frequently consumed entirely by that preamble before ever reaching the
   JSON. JSON extraction also picks the *last* balanced `{...}` object in the
   response rather than naively spanning from the first `{` to the last `}`,
   since draft/example JSON inside the reasoning preamble would otherwise get
   concatenated with the real answer into something unparsable. When a model
   still fails, its full prompt + raw response is saved to
   `data/phase2-failures/<modelKey>.txt` for offline diagnosis.
3. **Phase 3 — Stage-Gate Hyperparameter & Context Tuner**: enforces `Q8_0` KV
   cache quantization (best-effort — an `lms` version that rejects
   `--kv-cache-quant` as unknown just skips it with a warning, rather than
   aborting the run), steps GPU offload down until Shared GPU Memory ≤ 300MB
   and free VRAM ≥ 1500MB, then climbs a context ladder
   (8k → 16k → 24k → 32k → 48k → 64k) until system RAM ≥ 90%, shared GPU
   memory ≥ 300MB, or decode speed regresses ≥ 15% vs. the 8k baseline.
4. **Phase 4 — Standardized Aider Benchmark**: seeds an isolated git
   workspace with a 15-problem polyglot (TypeScript/JavaScript/Python/Go/Rust)
   refactoring slice, runs `aider` headlessly against it under a 15-minute
   cap, and grades the resulting pass rate, syntax-error count, and
   pre/post-run decode-speed decay. Every subprocess this suite spawns
   (`lms`, `powershell.exe`, `aider`, `git`) has its stdin explicitly closed
   rather than left to inherit the parent terminal's — without that, a
   process that unexpectedly hits a confirmation prompt sees a live,
   interactive TTY and blocks forever waiting for a keypress that never
   comes, instead of failing fast (reported: aider appeared to hang, and had
   opened `aider.chat/docs/llms/warnings.html` and
   `HISTORY.html#release-notes` in a browser — its own model-warnings and
   update-notification checks, neither suppressed by `--yes-always` alone).
   `buildAiderArgs` also passes `--no-check-update --no-show-release-notes
   --no-show-model-warnings --disable-playwright --no-analytics --no-gui` to
   stop those checks from running at all. Console logs show exactly when
   aider starts, the full command (with the long `--message` body summarized
   to its length), and how long it ran before finishing or hitting the
   timeout — and aider's own stdout/stderr are streamed live into the
   console as it runs (`CommandRunner`'s opt-in `streamOutput` option, in
   `src/subprocess.ts`), not just captured silently until it finishes, so a
   long Phase 4 run has visible progress instead of a 15-minute silence.

Every load — Phase 1, Phase 2, and each rung of Phase 3's offload/context
ladders — unloads whatever's currently loaded first. `lms load` on top of an
already-loaded model can stack a second instance or leave requests resolving
against a stale one instead of cleanly replacing it, which otherwise showed
up as later phases silently running against the wrong model or quantization
despite requesting the same modelKey. Phase 3 also reloads at
`maxRecommendedContext` if its context ladder stopped early on a guardrail,
so whatever's left loaded for Phase 4 always matches what the report says was
recommended, not the over-limit rung that tripped the guardrail — and skips
one redundant load entirely where it can: `resolveGpuOffload` already leaves
the model loaded at the winning offload for the ladder's first rung, so that
rung doesn't immediately reload the identical config again. Load/unload
cycling isn't free — LM Studio's `llama-server` backend has a known native
memory-mapping crash
([ggml-org/llama.cpp#18090](https://github.com/ggml-org/llama.cpp/issues/18090))
that a Windows run of this suite hit after several rapid cycles in under a
minute, so every avoidable cycle is worth cutting. The same reasoning applies
to a KV-cache-quant probe: once any load in a run discovers the installed
`lms` CLI doesn't support `--kv-cache-quant`, that's remembered for every
later load — Phase 3 alone can call `loadModel` a dozen-plus times per model
across its offload and context ladders, and previously every single one
re-attempted and re-failed the same flag. Phase 3 also logs every offload and
context rung it tries and the outcome, so the ladder's progress is visible
rather than only showing up as a burst of otherwise-unexplained load/unload
activity:

```
qwen/qwen3-30b-a3b-2507 — Phase 3: trying GPU offload max...
qwen/qwen3-30b-a3b-2507 — Phase 3: offload max → shared GPU 450MB, free VRAM 8000MB — too tight, stepping down
qwen/qwen3-30b-a3b-2507 — Phase 3: trying GPU offload 75%...
qwen/qwen3-30b-a3b-2507 — Phase 3: offload 75% → shared GPU 0MB, free VRAM 8000MB — OK
qwen/qwen3-30b-a3b-2507 — Phase 3: trying context 8192...
qwen/qwen3-30b-a3b-2507 — Phase 3: context 8192 → decode 22.1 tok/s (drop 0.0%), RAM 45%, shared GPU 0MB — OK
```

If a phase throws instead of returning a normal pass/fail — most commonly LM
Studio's `llama-server` engine crashing outright while loading or running one
specific model — that model alone is recorded as errored (`ERRORED_PHASE1`
through `ERRORED_PHASE4`, with the raw error message) and evaluation moves on
to the next model, rather than losing every other candidate's results to one
bad model. Only a genuinely dead/unreachable LM Studio *server* — a
`ServerCrashError`, checked via a health-check before each run and surfaced
whenever the HTTP API can't be reached — still aborts the whole run, since no
other model could be evaluated either in that case. The report's Errors
section lists exactly which phase failed and why for every errored model.

Results are written incrementally to `data/.pipeline_state.json` (atomic
write-then-rename, so a crash never leaves a truncated file), and a
`data/report_<timestamp>.md` comparison report is generated at the end of the
run. The report also flags, per model, when its tuned context ran close to
the RAM/VRAM guardrails (suggesting a smaller/more compressed quant would
leave more headroom) or left a lot of headroom unused (suggesting a
larger/less compressed quant could improve quality for free) — see
`src/recommendation.ts`. These are suggestions only; the suite never applies
them or picks a "winner" itself.

The report's Phase 1 and Phase 2 columns always show the measured tok/sec (or
failure reason) alongside pass/fail — for every model, not just discarded
ones — and the same numbers are logged live to the console as each phase
runs, so a run where every model gets discarded is diagnosable without
digging through state files: a `0.00 tok/sec` reading across the board means
the measurement pipeline is broken, not that every model is genuinely slow.

Console output is grouped by model, in the order the pipeline actually runs
each one through all four phases, rather than by phase number — every log
line leads with the model name so a long run reads top-to-bottom as one
model's whole story before moving to the next:

```
=== qwen2.5-coder-32b-instruct (Q4_K_M) ===
qwen2.5-coder-32b-instruct — Phase 1: PASS - 23.40 tok/sec (need >= 10 tok/sec)
qwen2.5-coder-32b-instruct — Phase 2: PASS
qwen2.5-coder-32b-instruct — Phase 3: max context 32768, GPU offload max, KV cache Q8_0
qwen2.5-coder-32b-instruct — Phase 4: 86.7% pass rate, 1 syntax errors, decode 24.5 tok/s (decay 3.2%)
```

The banner also shows the currently-selected quant — known from discovery
(`lms ls --json --variants` reports it) even though this suite can't change
it — and the report carries a matching "Quant" column, recorded up front for
every model so it's visible even for one discarded before Phase 3 ever runs.

With `--check-remote-quants`, a Quantization Notes recommendation ("try
Q4_K_S instead of Q4_K_M") also says whether that quant needs downloading:
`lms get` has no non-interactive/JSON listing mode, so this queries Hugging
Face's public API directly using the repo id recovered from discovery's
`indexedModelIdentifier` field, and reports whether the suggested quant is
already downloaded, published and downloadable, or not published under that
repo at all. Best-effort throughout — a model not hosted on HF, a renamed
repo, or a network hiccup just skips the note for that model rather than
failing anything.

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- [LM Studio](https://lmstudio.ai/) running its local server on port 1234,
  with the `lms` CLI on `PATH`
- [`aider`](https://aider.chat/) on `PATH` for Phase 4
- Language toolchains for whichever Phase 4 problems you want to execute:
  `bun`/`node` (TS/JS), `python3`, `go`, `rustc` — Phase 4 will report ordinary
  test failures for languages whose toolchain is missing, not silently skip
  them, so only keep toolchains installed for the languages you want graded
- PowerShell (`powershell.exe`) available for hardware telemetry (Windows)

## Usage

```sh
bun install

# download and select (in LM Studio) whichever quantization you want
# evaluated for each model first — there's no separate allow-list to
# maintain, but only the currently-selected variant per model is evaluated

bun run src/index.ts            # fresh run, all four phases
bun run src/index.ts --resume   # resume from data/.pipeline_state.json
bun run src/index.ts --phases=1,2         # only run the fast filters
bun run src/index.ts --phases=3 --resume  # re-tune Phase 3 for models that already have phase1/2 recorded
bun run src/index.ts --check-remote-quants  # also check Hugging Face for downloadable quant recommendations
```

`--phases` restricts which phases run this invocation (default: all four,
`1,2,3,4`). A phase not in the list is skipped entirely — not run, and not
treated as a failure — so `--phases=3` runs Phase 3 on every discovered model
regardless of whether Phase 1/2 have ever been recorded for it. Combine with
`--resume` to keep it from redoing whichever phases you did request but
already have results for.

## Development

```sh
bun test         # unit + integration tests (all external processes/HTTP mocked)
bun run typecheck
```

All subprocess execution (`lms`, `powershell.exe`, `aider`, `git`) goes
through the `CommandRunner` seam in `src/subprocess.ts`, and all HTTP calls to
LM Studio go through `src/apiClient.ts` — both are injected dependencies, so
the test suite never spawns a real process or opens a real socket.

## Out of scope

This suite does not restart a crashed LM Studio server, does not declare an
automatic "winner" model, and does not run the full 225-problem Aider
polyglot benchmark or 164-problem EvalPlus suite — Phase 4 is a standardized
15-problem, 15-minute sample intended for comparison, not certification.
