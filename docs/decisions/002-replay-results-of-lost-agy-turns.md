# ADR-002: Replay tool results that no live AGY turn takes

Accepted 2026-11-26 for the local AGY plugin implementation.

## Context

[ADR-001](001-native-agy-tool-routing.md) keeps a native turn open while the client runs its tools and reattaches the matching `tool_result` to it. The first release bounded the whole turn, including the time spent waiting for the client, and refused a result with HTTP 409 when its turn was gone. On a production session with 43 tool calls, the turn reached the 300-second bound while the client was running a tool. The client's following requests received eight 409 responses in about a minute before it abandoned the request. A client cannot bring back a native turn, so refusing a result only repeats until the client stops.

## Decision

Serve a tool result that no live turn takes by replaying the client's history in a new native turn. This covers a turn that ended, a turn that gave up its slot, a result that no longer matches the waiting call and a history that another session or account carries. Return 409 only while another request is still reading the same turn, because that turn is still producing the response.

Bound a native turn by its progress, not by its total time: a new transcript row restarts the bound, and time spent waiting for a client tool result does not count. Each wait for a tool result has its own longer bound. Under slot pressure, the turn whose client has held its call longest, beyond 30 seconds, gives up its slot; its later result replays.

## Consequences

A long client tool no longer ends a native turn that is otherwise progressing, and a lost turn costs one replay instead of a failed conversation. A replay is a new native turn: it re-reads history within the prompt budget and reports its own usage. The bridge logs content-free turn events so a replay can be traced to the reason its turn ended.

Configuration and limits are described in the [AGY plugin README](../../packages/agy-cli/README.en.md#concurrency-and-timeouts).
