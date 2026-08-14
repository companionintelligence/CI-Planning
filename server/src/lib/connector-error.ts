/**
 * One error contract for every connector that can be down.
 *
 * Ollama, the Google MCP transport and the CI-Server memory connector each grew their
 * own five-line "unavailable" class whose comment pointed at the other two. They are one
 * contract: *the connector could not serve this call; degrade, do not crash*. This base
 * expresses that once.
 *
 * This is ADDITIVE TYPING, not a rename. `OllamaUnavailable`, `McpUnavailable` and
 * `MemoryUnavailable` keep their exact names and their exact `.name` values, so every
 * existing `instanceof` check, every `toMatchObject({ name: … })` test and every log key
 * behaves identically — while `err instanceof ConnectorUnavailable` now narrows all three
 * for callers that only care that *a* connector is down.
 *
 * `connector` names which one ('ollama' | 'mcp' | 'memory') for callers that branch or
 * log without re-testing three classes.
 */
export class ConnectorUnavailable extends Error {
  constructor(
    public readonly connector: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorUnavailable';
  }
}
