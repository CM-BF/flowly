# Session layout focused fixture

This is a new, isolated test harness. It must not write to
`fixtures/session-pane/` or any implementation/spec/dependency file.

`run-components.mjs` is intentionally not invoked until the implementation
owner declares the work stable. It will install the temporary renderer under a
unique system temp directory and write run output plus a cleanup receipt here.
The component callback suite will be filled against the final exported
Markdown/follow helpers and preview component after that stability signal.

No Paseo project, workspace, card, session, GUI, daemon or plugin state belongs
to this fixture.
