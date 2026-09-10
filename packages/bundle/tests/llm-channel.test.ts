import { describe, expect, it } from 'vitest'
import { LlmChannel, type LlmRuntimeLike } from '../src/llm-channel.js'

interface Captured {
  options?: Record<string, unknown>
}

function runtime(chunks: Array<{ type: string; text?: string }>, captured: Captured): LlmRuntimeLike {
  return {
    stream(options) {
      captured.options = options as unknown as Record<string, unknown>
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

describe('LlmChannel', () => {
  it('concatenates text deltas and maps the request', async () => {
    const captured: Captured = {}
    const channel = new LlmChannel(
      runtime(
        [
          { type: 'block-start' },
          { type: 'text-delta', text: 'Hel' },
          { type: 'text-delta', text: 'lo' },
          { type: 'finish' },
        ],
        captured,
      ),
      { provider: 'deepseek-official', model: 'deepseek-chat' },
    )
    const reply = await channel.complete('system prompt', [{ role: 'user', content: 'hi' }])
    expect(reply).toEqual({ reply: 'Hello', ok: true })
    expect(captured.options?.provider).toBe('deepseek-official')
    expect(captured.options?.model).toBe('deepseek-chat')
    expect(captured.options?.system).toBe('system prompt')
    expect(captured.options?.maxTokens).toBe(800)
    const messages = captured.options?.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content[0]).toEqual({ type: 'text', text: 'hi' })
  })

  it('reports stream errors instead of throwing', async () => {
    const channel = new LlmChannel(
      {
        stream() {
          return (async function* () {
            throw new Error('boom')
          })()
        },
      },
      { provider: 'p', model: 'm' },
    )
    const reply = await channel.complete('s', [{ role: 'user', content: 'x' }])
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('boom')
  })

  it('fails when no text arrives', async () => {
    const channel = new LlmChannel(runtime([{ type: 'finish' }], {}), { provider: 'p', model: 'm' })
    const reply = await channel.complete('s', [{ role: 'user', content: 'x' }])
    expect(reply.ok).toBe(false)
  })

  it('passes the abort signal through', async () => {
    const captured: Captured = {}
    const channel = new LlmChannel(runtime([{ type: 'text-delta', text: 'x' }], captured), { provider: 'p', model: 'm' })
    const controller = new AbortController()
    await channel.complete('s', [{ role: 'user', content: 'x' }], controller.signal)
    expect(captured.options?.signal).toBe(controller.signal)
  })
})
