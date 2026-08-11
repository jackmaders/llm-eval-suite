# llm-eval-suite

A Bun/TypeScript CLI that systematically profiles candidate local GGUF models
loaded through [LM Studio](https://lmstudio.ai/) to find the best model and
configuration for pair-programming (sync) vs. overnight autonomous task
execution (async) on hybrid VRAM/RAM hardware.

Target environment: Windows 11, LM Studio's local server on
`http://127.0.0.1:1234`, models managed via the `lms` CLI, and hardware
telemetry sampled through PowerShell (`Get-CimInstance`, `Get-Counter`).

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
   pre/post-run decode-speed decay.

Every load — Phase 1, Phase 2, and each rung of Phase 3's offload/context
ladders — unloads whatever's currently loaded first. `lms load` on top of an
already-loaded model can stack a second instance or leave requests resolving
against a stale one instead of cleanly replacing it, which otherwise showed
up as later phases silently running against the wrong model or quantization
despite requesting the same modelKey. Phase 3 also reloads at
`maxRecommendedContext` if its context ladder stopped early on a guardrail,
so whatever's left loaded for Phase 4 always matches what the report says was
recommended, not the over-limit rung that tripped the guardrail.

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
