/**
 * The chat protocol, key resolution, and the OpenAI-compatible direct channel
 * now live in dsh-plugin-ops-core so the embedded bundle host shares one
 * implementation. This module re-exports the engine pieces for the standalone
 * `dsh-ops serve` panel.
 */
export {
  resolveModelConfig,
  OpenAiCompatibleChannel,
  buildSystemPrompt,
  buildChatContext,
  type ChatMessage,
  type ChatContext,
  type ChatReply,
  type ModelChannel,
  type ResolvedModelConfig,
} from 'dsh-plugin-ops-core'
