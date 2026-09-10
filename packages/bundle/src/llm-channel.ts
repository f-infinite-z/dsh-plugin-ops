import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatReply, ModelChannel } from 'dsh-plugin-ops-core'

/**
 * Minimal duck-typed view of the harness llm service. The bundle never
 * imports official runtime code (self-reliance): only the stable public
 * method surface the panel uses.
 */
export interface LlmRuntimeLike {
  stream(options: {
    provider: string
    model: string
    messages: unknown[]
    system?: string
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

export interface ModelSelectionLike {
  provider: string
  model: string
}

/**
 * Model channel over the official `ctx.llm` seam. Messages are plain objects
 * matching the harness Message contract (`id`/`role`/`content`/`source`); the
 * adapter reads `role` and `content`. Text deltas are concatenated into one
 * reply; any failure is reported through {@link ChatReply} instead of throwing
 * into the plugin tree.
 */
export class LlmChannel implements ModelChannel {
  constructor(
    private readonly llm: LlmRuntimeLike,
    private readonly selection: ModelSelectionLike,
  ) {}

  async complete(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ChatReply> {
    try {
      const options = {
        provider: this.selection.provider,
        model: this.selection.model,
        system,
        maxTokens: 800,
        messages: messages.map((message) => ({
          id: randomUUID(),
          role: message.role,
          content: [{ type: 'text', text: message.content }],
          source: { kind: 'plugin', plugin: 'dsh-plugin-ops-bundle' },
        })),
        ...(signal === undefined ? {} : { signal }),
      }
      let reply = ''
      for await (const chunk of this.llm.stream(options)) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') reply += chunk.text
      }
      return reply === ''
        ? { reply: '', ok: false, error: 'model returned no text' }
        : { reply, ok: true }
    } catch (error) {
      return { reply: '', ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
