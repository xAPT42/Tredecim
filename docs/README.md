# Documentation

The [project README](../README.md) is the argument. This is the reference.

## Reference

| | |
|---|---|
| [architecture.svg](architecture.svg) | The system in one drawing: an event, a checkpointed episode, and one transaction covering both the memory revision and the money move |
| [data-model.md](data-model.md) | Every table and index, what each column is for, and which invariant depends on it |
| [api.md](api.md) | The two HTTP routes the console speaks and the shapes they return |

## Operations

| | |
|---|---|
| [operations.md](operations.md) | Provisioning and inspecting the cluster with `ccloud`, and why authentication is interactive |
| [mcp.md](mcp.md) | The Managed MCP Server, and the schema drift detector it became |
| [security.md](security.md) | Credential separation, what the runtime role cannot do, and where secrets live |
| [testing.md](testing.md) | What each suite covers and what none of them cover |

## Decisions

Architecture decision records. Each states what was decided, what it cost, and what would
have to change for the decision to be revisited. They are worth more than the code comments
because they record the alternatives that were rejected, which the code cannot show.

| | |
|---|---|
| [0001](decisions/0001-bitemporal-not-versioned.md) | Two temporal axes rather than a version history |
| [0002](decisions/0002-embeddings-on-the-fact-rows.md) | Embeddings on the fact rows rather than a vector store |
| [0003](decisions/0003-partial-vector-index.md) | A partial vector index over the facts in force |
| [0004](decisions/0004-no-model-in-the-decision-loop.md) | No language model in the decision loop |
| [0005](decisions/0005-record-then-refuse.md) | Record a hostile fact, refuse to act on it |
| [0006](decisions/0006-durable-execution-over-in-process-state.md) | Durable execution rather than in-process agent state |

## Screenshots

`screenshots/` holds captures of the running console, for anyone reading this without a
browser open.

| | |
|---|---|
| `05-welcome` | The opening panel a first-time reader lands on |
| `06`–`08` | Guided steps, each dimming everything it is not about |
| `09-tour-divergence` | The two clocks disagreeing, a fact true in the world the agent did not know |
| `10-thirteen-relations` | Allen's thirteen, and which one the mark is |
| `11-poison` | An untrusted source asserting a destination: recorded, then refused at payout |
| `12-extraction-window` | The same refund run with deferred extraction and with one transaction |
| `01`–`04` | The divergence table, the architecture, the verification output, the lifeline |

## Skills

| | |
|---|---|
| [skills/audit.md](skills/audit.md) | Applying the CockroachDB Agent Skills to this cluster, and what they found |
