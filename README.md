# pi-todo

Stateful to-do extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Provides the agent with a persistent, structured plan that survives across turns and sessions.

## What It Does

pi-todo gives the agent a reliable planning surface with two views:

1. **Recited list** — compact overview injected into context every turn so the agent always knows what it's working on
2. **Per-item detail** — full agent-facing notes (definition of done, constraints, refs, deps, rationale, next step) addressable by ID

It also shows a persistent top-right overlay panel in the TUI that auto-hides when there are no todos.

## Tools

| Tool | Description |
|------|-------------|
| `todo_write` | Create or update todo items. Pass `replaceAll: true` to replace the entire list |
| `todo_set_status` | Change an item's status (`pending` → `in_progress` → `completed`). Enforces single `in_progress` invariant |
| `todo_get` | Fetch full detail of a single item by ID |
| `todo_list` | Show compact list without detail |

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
| `/todo` | Show todo list overlay |
| `/todo list` | Show todo list overlay |
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

## Overlay

A non-capturing overlay panel renders in the top-right corner showing:

- Completion counter (e.g. `2/5`)
- All items with status icons (`○` pending, `▶` in_progress, `✅` completed)
- Auto-hides when the list is empty

The overlay uses `nonCapturing: true` so it doesn't steal keyboard focus from the chatbox.

## Testing

```bash
node --test tests/todo.test.js
```

## License

MIT
