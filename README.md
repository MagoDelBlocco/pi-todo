# pi-todo

Stateful to-do extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Provides the agent with a persistent, structured plan that survives across turns and sessions.

## What It Does

pi-todo gives the agent a reliable planning surface with two views:

1. **Recited list** — compact overview injected into context every turn so the agent always knows what it's working on
2. **Per-item detail** — full agent-facing notes (definition of done, constraints, refs, deps, rationale, next step) addressable by ID

When the agent proposes a new plan, an interactive dialog lets you review and approve it, request changes, or reject it. The active item remains visible in the status bar.

## Tool

A single `todo` tool exposes four actions via the `action` parameter:

| Action | Description |
|--------|-------------|
| `write` | Create or update todo items. Creating a list or using `replaceAll: true` requires plan approval. |
| `set_status` | Change an item's status (`pending` → `in_progress` → `completed`). Enforces single `in_progress` invariant |
| `get` | Fetch full detail of a single item by ID |
| `list` | Show compact list without detail |

### Item Schema

Each item has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Stable short unique ID (e.g. `t1`, `t2`) |
| `headline` | `string` | Imperative user-facing headline |
| `status` | `string` | `pending`, `in_progress`, or `completed` |
| `detail.definitionOfDone` | `string` | Acceptance criteria |
| `detail.constraints` | `string[]` | Guardrails |
| `detail.refs` | `string[]` | Pointers: file paths, symbols, IDs |
| `detail.deps` | `string[]` | IDs this item depends on |
| `detail.rationale` | `string` | Why this item exists |
| `detail.nextStep` | `string` | One-line hand-off note |

### Dependency Checking

When `strictDeps` is enabled (default: `false`), setting an item to `in_progress` is blocked if its dependencies are not yet completed. When disabled, unmet deps produce a warning but allow the transition.

## Commands

| Command | Description |
|---------|-------------|
| `/todo` | Show todo list |
| `/todo list` | Show todo list |
| `/todo detail` | Select and view full detail of an item |
| `/todo clear` | Clear all todos (with confirmation) |

## Persistence

Todos are stored in `.pi/pi-todo.md` (project-local markdown file). When all items are completed, the list is retired to `.pi/pi-todo.done.md` with a timestamp.

### File Format

```markdown
# Todo List

- [ ] t1: Read the requirements
- [>] t2: Implement the feature
  - definitionOfDone: Feature works end-to-end
  - constraints: No external dependencies
  - deps: t1
  - nextStep: Write unit tests
- [x] t3: Write tests
```

Markers: `[ ]` = pending, `[>]` = in_progress, `[x]` = completed.

## Plan approval

New plans and full replacements open a temporary review dialog with three choices: Approve plan, Request changes, and Reject plan. Use `↑`/`↓` to choose and `Enter` to select. Use `PageUp`/`PageDown` to scroll the plan preview; `Esc` cancels without saving. Requested changes are returned to the agent; unapproved plans are not saved. Routine item updates and status changes do not reopen the dialog. In clients without a custom TUI, the extension uses a select/input dialog; without interactive UI, it reports that approval is unavailable.

## Testing

```bash
node --test tests/todo.test.js
```

## License

MIT
