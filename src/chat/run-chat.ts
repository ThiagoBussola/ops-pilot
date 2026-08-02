import { OPSPILOT_SYSTEM_PROMPT } from "../agents/system-prompt.js";
import type {
  ContextBreakdown,
  ConversationMessage,
  ConversationStore,
  ExecutionMetrics,
  MemoryStore,
  ReasoningStrategy,
  RecalledMemory,
  StrategyResult,
  TraceEvent,
} from "../domain/types.js";
import { runWithChatUser } from "../memory/chat-user-context.js";
import {
  scheduleLearning,
  type LearningReflectorFn,
} from "../memory/learning-reflector.js";
import { buildContextBreakdown } from "../context/tokens.js";
import {
  formatSummaryForPrompt,
  HISTORY_LIMIT,
  maybeSummarize,
  type ConversationSummarizer,
} from "./history-summarizer.js";

export { HISTORY_LIMIT };

export interface ChatInput {
  message: string;
  userId: string;
  conversationId?: string;
}

export interface ChatTurnResult {
  conversationId: string;
  answer: string;
  trace: TraceEvent[];
  metrics: ExecutionMetrics & {
    historyMessages: number;
    recalledMemories: number;
    contextBreakdown: ContextBreakdown;
  };
}

export interface RunChatOptions {
  /** Wrap the strategy promise (e.g. HTTP timeout). Defaults to identity. */
  execute?: (promise: Promise<StrategyResult>) => Promise<StrategyResult>;
  /** Optional post-turn learning reflector (async remember; does not block return). */
  learningReflector?: LearningReflectorFn;
  /** Optional history summarizer (batch prune). Absent → window only, no summarize. */
  summarizer?: ConversationSummarizer;
}

/** Inject recalled facts into the user message (strategies stay unchanged). */
export function formatMemoriesForPrompt(
  recalled: RecalledMemory[],
  currentMessage: string,
): string {
  if (recalled.length === 0) {
    return currentMessage;
  }
  const lines = recalled.map((m) => `- ${m.fact}`);
  return `Relevant memories:\n${lines.join("\n")}\n\nCurrent message:\n${currentMessage}`;
}

/** History text for token estimate (no current message). */
export function formatHistoryText(history: ConversationMessage[]): string {
  if (history.length === 0) {
    return "";
  }
  return history.map((m) => `${m.role}: ${m.content}`).join("\n");
}

/** Recalled facts text for token estimate (no envelope). */
export function formatMemoriesText(recalled: RecalledMemory[]): string {
  if (recalled.length === 0) {
    return "";
  }
  return recalled.map((m) => `- ${m.fact}`).join("\n");
}

/**
 * Persist turn + run strategy with history, optional summary prune, and semantic memory.
 * Flow: create/load → maybeSummarize → lastMessages(8) → recall → enrich → append user
 * → run → append assistant → scheduleLearning.
 */
export async function runChat(
  conversations: ConversationStore,
  memories: MemoryStore,
  strategy: ReasoningStrategy,
  input: ChatInput,
  options: RunChatOptions = {},
): Promise<ChatTurnResult> {
  const conversationId = input.conversationId ?? conversations.create();

  let summarizeEvent: TraceEvent | undefined;
  if (options.summarizer) {
    const summarized = await maybeSummarize({
      conversations,
      conversationId,
      summarizer: options.summarizer,
    });
    if (summarized) {
      summarizeEvent = summarized.event;
    }
  }

  const history = conversations.lastMessages(conversationId, HISTORY_LIMIT);
  const summaryRecord = conversations.getSummary(conversationId);
  const summaryText = summaryRecord?.text ?? null;
  const recalled = await memories.recall(input.userId, input.message);

  let enrichedMessage = formatMemoriesForPrompt(recalled, input.message);
  enrichedMessage = formatSummaryForPrompt(summaryText, enrichedMessage);

  conversations.append(conversationId, "user", input.message);

  const result = await runWithChatUser(input.userId, async () => {
    const runPromise = strategy.run({ message: enrichedMessage, history });
    return options.execute?.(runPromise) ?? runPromise;
  });

  conversations.append(conversationId, "assistant", result.answer);

  if (options.learningReflector) {
    void scheduleLearning({
      reflector: options.learningReflector,
      memories,
      userId: input.userId,
      userMessage: input.message,
    }).catch(() => {
      /* already fail-safe inside scheduleLearning */
    });
  }

  const contextBreakdown = buildContextBreakdown({
    system: OPSPILOT_SYSTEM_PROMPT,
    history: formatHistoryText(history),
    memories: formatMemoriesText(recalled),
    message: input.message,
    summary: summaryText ?? "",
  });

  const metrics: ChatTurnResult["metrics"] = {
    ...result.metrics,
    historyMessages: history.length,
    recalledMemories: recalled.length,
    contextBreakdown,
  };
  if (result.metrics.promptTokens === undefined) {
    delete metrics.promptTokens;
  }

  const trace = summarizeEvent ? [summarizeEvent, ...result.trace] : result.trace;

  return {
    conversationId,
    answer: result.answer,
    trace,
    metrics,
  };
}

/** Format history for strategies that still consume a single text blob (e.g. plan-execute). */
export function formatHistoryForPrompt(
  history: ConversationMessage[],
  currentMessage: string,
): string {
  if (history.length === 0) {
    return currentMessage;
  }
  const lines = history.map((m) => `${m.role}: ${m.content}`);
  return `Previous conversation:\n${lines.join("\n")}\n\nCurrent message:\n${currentMessage}`;
}
