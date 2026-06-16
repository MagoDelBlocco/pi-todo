# Pi Extension API Notes — pi-todo

## Extension Registration

- **Format**: TypeScript module with `export default function (pi: ExtensionAPI) { ... }`.
- **Locations**: `~/.pi/agent/extensions/*.ts` (global) or `.pi/extensions/*.ts` (project-local). Also `*/index.ts` for subdirectories.
- **Hot-reload**: `/reload` re-discovers extensions in auto-discovered locations. Emits `session_shutdown` then `session_start` with `reason: "reload"`.
- **Loading**: Uses [jiti](https://github.com/unjs/jiti) — no compilation needed.

## Tool Registration

`pi.registerTool(definition)` where definition has:

```ts
{
  name: string;           // snake_case, e.g. "todo"
  label: string;          // Display name
  description: string;    // When to use this tool
  promptSnippet?: string; // One-line entry in "Available tools"
  promptGuidelines?: string[]; // Bullets appended to Guidelines section
  parameters: TObject;    // TypeBox schema
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<{
    content: [{ type: "text", text: string }],
    details?: object,
  }>;
  renderCall?(args, theme, context): Component;
  renderResult?(result, { expanded }, theme, context): Component;
}
```

Tools can be registered during extension load or at any time (e.g., inside `session_start`). New tools appear immediately without `/reload`.

## Per-Turn Recitation Hook

**`context` event** — fires before each LLM call (every turn). Receives `event.messages` (deep copy of `AgentMessage[]`). Return `{ messages: modifiedArray }` to replace.

This is the correct hook for injecting the recited todo block at the end of context every turn. Append a `UserMessage` to `event.messages` and return it. The modification is transient (not persisted to session).

**`before_agent_start`** — fires once per user prompt (before agent loop). Can inject a persistent `CustomMessage` via `return { message: { customType, content, display } }`. Not per-turn, so not suitable for recitation.

## Session Persistence

- **`pi.appendEntry(customType, data?)`** — persists extension state as `CustomEntry` in session JSONL. Does NOT participate in LLM context.
- **File-based persistence** — use `node:fs` to read/write files. The todo file (`.pi/pi-todo.md`) is the source of truth at session boundaries.
- **Session start**: `session_start` event with `reason: "startup" | "reload" | "new" | "resume" | "fork"`.
- **Session shutdown**: `session_shutdown` event with `reason: "quit" | "reload" | "new" | "resume" | "fork"`.

## Commands

`pi.registerCommand(name, { description, handler(args, ctx) })`. Invoked as `/name`.

## TUI

- `ctx.ui.custom(component)` — replace editor with custom component.
- `ctx.ui.custom(component, { overlay: true })` — overlay on top of existing UI.
- `ctx.ui.setWidget(id, lines)` — persistent widget above/below editor.
- `ctx.ui.setStatus(id, text)` — footer status indicator.
- `ctx.ui.notify(message, level)` — toast notification.
- Components: `Text`, `Box`, `Container`, `Spacer`, `Markdown`, `SelectList`, `SettingsList`, `BorderedLoader` from `@earendil-works/pi-tui`.

## Message Types

`AgentMessage` union: `UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage`.

For injecting into `context` event: use `UserMessage` shape:
```ts
{ role: "user", content: [{ type: "text", text: "..." }], timestamp: number }
```

## Deviations from Spec

- **No dedicated "per-turn pre-model hook" named as such** — the `context` event serves this purpose.
- **No built-in to-do tool** — confirmed by reading README ("No built-in to-dos. They confuse models."). Building fresh.
- **Recitation via `context` event** — appends a transient `UserMessage` to the message array each turn. Not persisted to session.
- **File-based persistence** — `.pi/pi-todo.md` is the source of truth, loaded on `session_start`. In-memory state is reconstructed from the file, not from session entries.
