# Default models (global and per project)

Status: implemented on the user's request (2026-10-16): a Models page in the settings with a default model, and a default model per project that overrides it.

## 1. What it is

The model a **new session** starts with: provider, model and optional reasoning effort. It prefills the "New session" form and the agent picker of "New task → Start an agent now". The user can still change it in those forms; nothing is forced on an existing session.

The default also carries an optional **permission mode** (`modeId`) and, per project, **speed** (`featureValues`). With no mode set (`modeId` absent), the form keeps the latest session's mode when the provider is the same, else the provider default; `modeId: ""` explicitly chooses the provider default. Under agent automation with Full access on, the provider's no-approval mode overrides any of these (AUTOMATION-SPEC §2). Not covered: the summary model (separate, see §4).

CM-BF/flowly merge of upstream #40 (2026-10-23): upstream added a separate `mode` field to the model; the fork already stored `modeId`/`featureValues` in the same strict schema (project defaults, automation roles, queued launches), so the fork keeps `modeId` and upstream's global `defaultMode` maps to it. No `mode` field is stored.

## 2. Precedence

`effectiveAgentModel(project, global)` in `shared/agent-defaults.ts`, strongest first:

1. the project's `agentModel`, when set;
2. the global default (`models` host setting), when set (`defaultProvider` and `defaultModel` both non-empty);
3. nothing: the form starts from the latest session's settings, as before this feature (`startingAgent`).

A project default replaces the global one as a whole (provider, model and reasoning together); it is never merged field by field. If the chosen provider is not available on this machine the form falls back as it always did (an available provider, its default model).

## 3. Data

- Global: host-scoped setting `models` = `{ defaultProvider, defaultModel, defaultThinking, defaultMode }`, empty strings meaning none. Registered in `index.server.ts`. `agentModelFromValues` maps a non-empty `defaultMode` to `modeId`; `""` means inherit, because a flat string cannot also say "explicit provider default".
- Project: optional `agentModel: { provider, model, thinking?, modeId?, featureValues? }` on the project record. No board migration (absent on existing projects). `projects.update` takes `agentModel`; a model sets it, `null` removes it; it goes through the usual project revision check, so a stale edit is rejected. The model is validated by `agentModelSchema` (strict, non-empty ids; `modeId` may be `""`). The schema is shared with storage, so it is not tightened with an id regex: a stricter schema could make a stored board unreadable.

## 4. UI

- **Settings → Models**: *Default model* (Provider, Model, Reasoning) and *Summary models* (an ordered fallback list; see [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md)). Provider's first choice is **Automatic** (no default). Choosing a provider also chooses its default model, so a default is always complete.
- **Project settings → Default model**: the same three rows; the provider's first choice reads **Global default (…)** (the current global one, or Automatic) and means "no override".
- **Settings → Models → Default model** has a **Permissions** row after Reasoning (`ModelDefaultGroup permissions`): "Same as latest session" (stored as `defaultMode: ""`; the form then keeps the latest session's mode when it uses the same provider, else the provider default) plus the provider's modes. It offers no explicit "Provider default" and no Speed, which the flat setting cannot store.
- **Project settings** and the automation role pickers (`ModelDefaultGroup execution`) have the fork's **Permissions** row ("Follow existing defaults" = inherit, "Provider default" = `""`, or a mode) and **Speed**. Changing the provider clears the mode, since mode ids belong to a provider.
- The Reasoning row only appears when the model offers options; "Model default" keeps the model's own.

## 5. Acceptance

[verification/model-defaults.md](verification/model-defaults.md)
