# Skills

Agent skills packaged from this library's engineering judgment — not from its source.
The library is the implementation; these are the method, written to apply to any
codebase in any language or SDK.

| Skill | What it does |
| --- | --- |
| [`agent-loop-audit`](agent-loop-audit/) | Audits an existing LLM agent loop and its tool surface for the defects that survive code review and a green test suite. Nine loop checks, seven tool-surface checks. |
| [`typed-agent-harness`](typed-agent-harness/) | Builds the production scaffolding around an agent loop: validated tool input, declarative approval gates, a context budget, a verification pass, typed errors, a readable trace. Opens by telling you when *not* to use it. |

Each is a standard `SKILL.md` folder and installs into any agent that reads the
format.

## Tested, not asserted

Both were measured against a no-skill baseline on the same task with the same model.

**`agent-loop-audit`** — run against [`evals/finds-planted-defects-ts`](agent-loop-audit/evals/finds-planted-defects-ts/),
a support agent carrying nine planted defects and five things deliberately done right:

| Run | Findings | False positives |
| --- | --- | --- |
| With the skill | 28 | 0 |
| No skill at all | 24 | 0 |
| First draft of the skill | 8 | 0 |

The first draft lost to using no skill at all. It found every planted defect and
still reported a third as much, because a numbered checklist reads as the scope of
the job — the run worked the list and stopped, while the baseline read the tool
bodies and found sixteen more real defects. Hence the section that now opens the
file: the checklist is a floor, not a ceiling.

**`typed-agent-harness`** — both arms got the same needs-phrased brief and the same
public API contract, then were scored by the 20-check executable suite in
[`evals/builds-conformant-harness`](typed-agent-harness/evals/builds-conformant-harness/),
which neither arm saw:

| Run | Score |
| --- | --- |
| With the skill | 19/19 |
| No skill at all | 14/19 |

The decisive failure: the baseline executed a tool on a turn truncated at
`max_tokens` and reported the run as a success — a refund issued from arguments cut
off mid-number, with the caller told it worked. Nothing raises, because truncated
JSON parses cleanly.

Honest about where the skill did *not* matter: loop shape, parallel-result batching,
approval gating, unknown-tool handling and rejected parameters. The baseline got all
of those right unaided.

## Running the evals

```bash
claude plugin eval skills/agent-loop-audit/evals/finds-planted-defects-ts
```

```bash
npx tsx skills/typed-agent-harness/evals/builds-conformant-harness/graders/conformance.ts <build-dir>
```

The audit eval's fixture contains working path-traversal code on purpose — it is
what the skill is meant to find. Keep it out of anything you upload to a marketplace
that runs an automated security scan.
