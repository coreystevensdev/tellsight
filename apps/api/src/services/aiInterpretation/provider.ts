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
// this layer, callers must validate before trusting it (see proposalValidation.ts
// for the record_proposal case). `id` correlates a call to the ToolResultInput
// answering it in a multi-turn conversation.
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

// Answers one ToolCall from a completed turn, threaded back into the next
// converseWithTools call so the model sees its own tool's result. `isError`
// marks a call the orchestrator rejected (malformed input, unknown tool
// name), not a failure inside the tool itself.
export interface ToolResultInput {
  toolCallId: string;
  output: unknown;
  isError?: boolean;
}

// One turn of a multi-turn tool-calling conversation. `state` is opaque to
// the caller, thread it back into the next converseWithTools call unchanged.
export interface ConversationTurn {
  state: unknown;
  toolCalls: ToolCall[];
  text: string;
  usage: { inputTokens: number; outputTokens: number };
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
  // single-turn only, see converseWithTools below for a multi-turn loop.
  // onCost mirrors stream's onText callback shape: an optional side channel
  // so callers that need per-call spend (run-level budget tracking) can get
  // it without widening the return type every existing caller asserts on.
  generateTool(input: PromptInput, tools: ToolDefinition[], onCost?: (cost: number | null) => void): Promise<ToolCall[]>;
  // Multi-turn tool-calling conversation. Pass state: null to start; thread
  // each turn's returned state into the next call along with ToolResultInputs
  // answering that turn's ToolCalls (an empty array is only valid when state
  // is null). Pass tools: [] to force a text-only turn, used for a turn-cap
  // or cost-cap forced final answer.
  converseWithTools(
    state: unknown,
    input: PromptInput,
    tools: ToolDefinition[],
    toolResults: ToolResultInput[],
    signal?: AbortSignal,
  ): Promise<ConversationTurn>;
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
