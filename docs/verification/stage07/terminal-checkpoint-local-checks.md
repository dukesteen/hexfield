# Terminal checkpoint local checks

Date: 2026-09-28. These are local regression checks, not network acceptance runs.

## Frozen source

SHA-256 hashes captured after the repair review follow-up:

| File                                               | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/protocol/src/master-reveal.ts`           | `444b6ad154bd83608a414a3062c6095511e1a82ae43c6a8fe6e33638cab83154` |
| `packages/protocol/src/replicated-log.ts`          | `89f28ff166f5063e172bcae4d3eb83b22fb881cc34658eb2071769837d210245` |
| `packages/protocol/src/master-reveal-live.test.ts` | `905f0d428a544fb8e81bb712419042d517b7c17eb34c367cb5104e51a89829fb` |
| `packages/protocol/src/replicated-log.test.ts`     | `57bc14e874d1b21a0243f2868f923b9db48cbee53a07de4977718de6b7b3f616` |

## Results

- Full new live-test run, handle `76308`: 11 of 12 cases passed; test time 17.635 s, runner time 18.58 s. The remaining fixture incorrectly included a local precommit absent from durable safety, so the replica correctly refused its certificate.
- Corrected final case, handle `14246`: 1 passed, 11 skipped; test time 14.227 s including fixture preparation, runner time 15.47 s. The case itself took 1.181 s. Its certificate uses the other three genuine voter signatures. It asserts that the first repair call detects context corruption and enters quarantine, then the second call repairs against the certified snapshot.
- Existing `master-reveal.test.ts`, handle `10451`: 5 of 5 passed; test time 27.053 s, runner time 28.56 s, within its existing 120 s fixture bound.
- Shared test TypeScript check, handle `84370`: passed. Scoped type-aware lint and formatting checks for the new live test: passed.
- Root's final Node 22 production `pnpm build`: passed; log at `/private/tmp/hexfield-checkpoint-production-build.log`. Root's scoped source-and-test type-aware lint and formatting checks also passed.
- Dependency graph and boundary checks passed with `pnpm deps:check`. The live checkpoint adapter remains absent from both public protocol entry points.

The final lint cleanup replaced a conditional error assertion with the equivalent unconditional object assertion. No further test run was needed for that assertion-only change.

## Coverage and limits

The new fixture uses verified genesis and genuine four-peer certification of a legal base-engine command. A custom engine marks that first command terminal, keeping checkpoint mechanics bounded. It does not demonstrate a base-game victory, terminal audit, browser recovery, or full-game network acceptance.

The eleven guard cases compare live restore replay with standalone coordinator replay; reject derived-state, engine, replay-policy, durable-head and same-height safety mutations before master access or persistence; reject an invalid earlier certificate during full restore; and prevent disclosure after disposal during journal, source or store awaits. The final case preserves the earliest certified result across a valid later control entry and derived-context repair. No caller-supplied checkpoint is used.

The separate existing tests use their real base-game 3 VP fixture. They cover standalone and historical receipt behavior, durable signed disclosure and restart, authenticated acceptance, forged/context-mismatched disclosure rejection, corrupt accepted-slot handling, and disposal during asynchronous work. They provide regression evidence for those paths, not the Stage07 full-game acceptance gate.

## Review follow-up: repair lifecycle

Review found a preexisting repair race: disposal during controller restoration or its safety recheck could install and resume a controller afterward. Repair now rechecks its original context and repair hold across awaits, disposes stale restored controllers, and rejects invalidated work. General controller opening checks context, hold and disposal before installation. Effect delivery refuses a disposed replica, including closure during resumed controller persistence.

Both repair paths compare fresh replay against the original controller's opening stamp. A replacement engine function cannot be blessed by opening a new controller; a transient verdict change inside the same callback remains repairable.

- Handle `55840`: 3 selected live tests passed in 15.082 s (runner 16.11 s): disposal at controller restore's safety read, disposal at the following durable safety recheck, and successful post-result control/repair. Both disposal cases require a rejected repair, no installed controller, no outgoing packets and no timers.
- Handle `97827`: 15 selected replica tests passed in 591 ms (runner 1.62 s): existing derived-context repair variants, unchanged-callback certified-validation repair, and a new engine-function replacement during the repair journal await. The replacement has identical behavior but must be rejected without changing durable safety or history.
- Scoped type-aware lint, formatting, and final shared test typecheck `75403` passed after these changes. Root's final Node 22 production build `58061` and scoped source/test lint and formatting `62503` also passed after the repair fix; build log: `/private/tmp/hexfield-checkpoint-production-build-final.log`.
