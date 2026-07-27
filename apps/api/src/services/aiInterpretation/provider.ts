export interface StreamResult {
  fullText: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderHealth {
  status: 'ok' | 'error';
  latencyMs: number;
}

// Split into system + user so providers that support prompt caching can mark
// the system half as cacheable. Empty `system` means "send only user message"
//, the provider should not attach cache_control or a system field.
export interface PromptInput {
  system: string;
  user: string;
}

// A tool the model may call. inputSchema is a JSON Schema object describing
// the shape of `input` on any resulting ToolCall.
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// One invocation the model made against a tool. `input` is unvalidated at
// this layer, callers must validate before trusting it (see parseProposals.ts
// for the record_proposal case).
export interface ToolCall {
  name: string;
  input: unknown;
}

// Pluggable LLM contract. One active provider at a time, selected via config.
// Each provider owns its own SDK, retries, circuit breaker, and error mapping.
// Callers work with this interface, never with Anthropic (or any other) SDK directly.
export interface LlmProvider {
  name: string;
  generate(input: PromptInput): Promise<string>;
  stream(input: PromptInput, onText: (delta: string) => void, signal?: AbortSignal): Promise<StreamResult>;
  // Tool choice is always 'auto' internally, zero calls back is a valid result
  // (nothing worth calling the tool for), not an error. No message history,
  // single-turn only; a multi-turn loop is a different, larger method.
  generateTool(input: PromptInput, tools: ToolDefinition[]): Promise<ToolCall[]>;
  checkHealth(): Promise<ProviderHealth>;
}

let activeProvider: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (!activeProvider) {
    throw new Error('LLM provider not registered, call registerProvider() at boot');
  }
  return activeProvider;
}

export function registerProvider(provider: LlmProvider): void {
  activeProvider = provider;
}

// Test-only, lets a test reset module state between runs.
export function resetProvider(): void {
  activeProvider = null;
}
