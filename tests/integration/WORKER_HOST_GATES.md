# Worker Host-Gated Tests

The deterministic worker E2E suite (`tests/integration/workers.smoke.test.ts`) always runs: it
exercises the full pipeline (worktree → diff → boundary audit → sanitize → validation gates →
cross-model review → approval → working-tree merge) against a **real temp git repo** using fake
`node -e` adapters. No external LLM CLI is required for those proofs.

Real provider CLIs are exercised only behind **host gates** — they are **skipped, never failed**,
when the adapter or its env marker is absent. This keeps CI green on hosts without the CLIs while
letting an operator opt in.

## Installed adapters on this host (recorded 2026-06-16)

| Adapter | CLI            | Present? |
|---------|----------------|----------|
| codex   | `codex`        | **yes**  |
| gemini  | `gemini`       | no       |
| local   | `ollama` / `llama-cli` | no |

`node` is required for the deterministic suite and is present (`node --version` ≥ 22).

## Tiers and env markers

| Tier              | Env marker              | Marker tag           | Runs when                          |
|-------------------|-------------------------|----------------------|------------------------------------|
| Codex real run    | `AISUP_TEST_CODEX=1`    | `@requires_codex`    | marker set **and** `codex` on PATH |
| Gemini real run   | `AISUP_TEST_GEMINI=1`   | `@requires_gemini`   | marker set **and** `gemini` on PATH|
| Local-LLM real run| `AISUP_TEST_LOCAL_LLM=1`| `@requires_local_llm`| marker set **and** local CLI on PATH|

## Run procedure

Always-run deterministic suite (no external CLI):

```bash
npx vitest run tests/integration/workers.smoke.test.ts
# → 9 deterministic ACs pass; the 3 host tiers skip.
```

Codex tier (available on this host):

```bash
AISUP_TEST_CODEX=1 npx vitest run tests/integration/workers.smoke.test.ts
# → the @requires_codex tier runs; gemini/local tiers skip.
```

Gemini / local tiers (not installed here — install the CLI first, then):

```bash
AISUP_TEST_GEMINI=1   npx vitest run tests/integration/workers.smoke.test.ts
AISUP_TEST_LOCAL_LLM=1 npx vitest run tests/integration/workers.smoke.test.ts
```

When a marker is set but the CLI is missing, configure the matching adapter in
`~/.aisup/config.yaml` (`workers.adapters.<name>.command` / `args` / `prompt_via`) to match your
installed version — the presets ship **disabled** with conservative defaults and no invented
flags. Until then, the tier asserts only the env marker and does not invoke a missing binary, so it
never fails CI.

## Safety

Every scenario uses an isolated temp `workspace_root` and an isolated temp worker state dir; the
real repo and the real `~/.aisup` are never touched. No worktrees, review dirs, or state files are
left behind after the suite (temp dirs are removed in `afterEach`).
