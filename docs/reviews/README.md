# Phase reviews

Append-only output artifacts of the **[End-of-Phase Review](../process/end-of-phase-review.md)** — the mandatory two-stage hard gate run at the close of every roadmap phase.

- One file per phase: `phase-<N>-review.md` (e.g. `phase-1-review.md`).
- Each records: findings (Axes A/B/C, severity-tagged), ADR amendment proposals, the remediation plan (intra-phase hard gate + future-roadmap insertions), and the verdict.
- Never rewritten — a review is a dated snapshot. Follow-up state lives in the roadmap and HANDOVER, not here.

Run the protocol on **Fable 5** (Opus 4.8 for small phases). The phase is not closed until its review verdict is not `BLOCKED` **and** its intra-phase remediation roadmap is complete and re-verified.
