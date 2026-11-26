# ADR-001: Route AGY TUI tools through native MCP

Accepted 2026-11-26 for the local AGY plugin implementation.

## Context

The first TUI mode sent text-only requests through `agy`'s interactive terminal and used ACP for the rest. The replacement removes mode selection and uses the native terminal for model generation and Google sign-in. Model discovery and quota use their own native CLI commands. As in Magpie's Claude bridge, the client still owns tool execution, and the actual result must return to the turn that asked for it.

## Decision

Give each native turn a private MCP catalog and use AGY's stdio MCP support to reach the plugin's existing loopback tool bridge. Keep the PTY and the MCP request open after emitting a client `tool_use`. Reattach a matching `tool_result` to that callback rather than replacing it with a prompt or using ACP. Tool delivery follows the order in which AGY invokes the callbacks; the bridge cannot wait to bundle calls that AGY makes serially.

Read completed text from the native turn transcript, not from terminal repaint bytes. Claude Code's Bun fetch tap has no equivalent runtime hook in the tested AGY Go binary. Revisit live deltas when AGY provides an observable event source with append-only reply text before a step finishes.

## Consequences

The native turn occupies a process slot while it waits for client tools, within the same turn deadline. An unchanged turn can receive text results in place. Changes to the turn's tool catalog or instructions, or tool results containing images, require a new native turn with the actual result in its history. Generation has no second execution path.

Current configuration and limits are described in the [AGY plugin README](../../packages/agy-cli/README.en.md#native-tui).
