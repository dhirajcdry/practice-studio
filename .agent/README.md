# Durable engineering decisions

Read the root [AGENTS.md](../AGENTS.md) first. This directory is an index of decisions,
not another conflicting agent policy and not a runtime prompt or learner-memory folder.

- [Native conversations](../docs/NATIVE-CONVERSATIONS.md): identities, context delivery,
  compaction, interruption, permissions, expiry and regression checks.
- [Context and storage](../docs/CONTEXT.md): canonical track data and evidence retrieval.
- [UI contract](../docs/UI.md): shared layout, spacing, controls and voice surfaces.
- [Decision log](DECISIONS.md): why the architecture changed and the actual delegation used.

When changing one of these contracts, update its canonical document and the regression
that enforces it. Record the new reason here; do not silently return to an earlier design.
