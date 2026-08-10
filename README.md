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
   AST-parsing prompt.
3. **Phase 3 — Stage-Gate Hyperparameter & Context Tuner**: enforces `Q8_0` KV
   cache quantization, steps GPU offload down until Shared GPU Memory ≤ 300MB
   and free VRAM ≥ 1500MB, then climbs a context ladder
   (8k → 16k → 24k → 32k → 48k → 64k) until system RAM ≥ 90%, shared GPU
   memory ≥ 300MB, or decode speed regresses ≥ 15% vs. the 8k baseline.
4. **Phase 4 — Standardized Aider Benchmark**: seeds an isolated git
   workspace with a 15-problem polyglot (TypeScript/JavaScript/Python/Go/Rust)
   refactoring slice, runs `aider` headlessly against it under a 15-minute
   cap, and grades the resulting pass rate, syntax-error count, and
   pre/post-run decode-speed decay.

Results are written incrementally to `data/.pipeline_state.json` (atomic
write-then-rename, so a crash never leaves a truncated file), and a
`data/report_<timestamp>.md` comparison report is generated at the end of the
run. The report also flags, per model, when its tuned context ran close to
the RAM/VRAM guardrails (suggesting a smaller/more compressed quant would
leave more headroom) or left a lot of headroom unused (suggesting a
larger/less compressed quant could improve quality for free) — see
`src/recommendation.ts`. These are suggestions only; the suite never applies
them or picks a "winner" itself.

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

bun run src/index.ts            # fresh run
bun run src/index.ts --resume   # resume from data/.pipeline_state.json
```

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
