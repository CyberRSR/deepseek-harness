/** The Messages request deadline belongs to the adapter's idle watchdog, not Node's transport defaults. */
import { describe, expect, it, vi } from 'vitest'

const fetchWithCallerDeadlines = vi.hoisted(() => vi.fn())

vi.mock('@deepseek-ai/dsh-http-proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-http-proxy')>()
  fetchWithCallerDeadlines.mockImplementation(actual.fetchWithCallerDeadlines)
  return { ...actual, fetchWithCallerDeadlines }
})

import { adapter, chunks, options, server } from './helpers.ts'

describe('Messages transport deadlines', () => {
  it('sends the Messages request through the fetch whose deadline is the idle watchdog', async () => {
    const http = await server()
    try {
      const output = await chunks(adapter({ baseURL: http.url }).stream(options()))
      expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(fetchWithCallerDeadlines).toHaveBeenCalledOnce()
      expect(fetchWithCallerDeadlines.mock.calls[0]?.[0]).toBe(`${http.url}/v1/messages`)
    } finally {
      await http.close()
    }
  })
})
