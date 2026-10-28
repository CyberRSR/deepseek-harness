import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pruneRunLogs, RunLog, runLogFileName, type CapturedConsole } from '../src/run-log.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-run-log-'))
  roots.push(root)
  return root
}

function openLog(root: string, maxBytes?: number): RunLog {
  const log = RunLog.open(root, ['app: fixture 1.0.0'], new Date('2026-10-28T02:21:22.291Z'), maxBytes)
  if (log === undefined) throw new Error('run log fixture could not be opened')
  return log
}

/** Logged lines after the header, without their timestamps. */
async function entries(log: RunLog): Promise<string[]> {
  const lines = (await readFile(log.path, 'utf8')).split('\n')
  return lines.slice(lines.indexOf('') + 1).filter(line => line.length > 0).map((line) => {
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[/u)
    return line.slice(line.indexOf(' ') + 1)
  })
}

describe('run log', () => {
  it('names each launch by its UTC start time', () => {
    expect(runLogFileName(new Date('2026-10-28T02:21:22.291Z'))).toBe('run-2026-10-28T02-21-22-291Z.log')
  })

  it('writes the header, then each complete line with its source, joining lines split across chunks', async () => {
    const log = openLog(await directory())
    log.write('host:stdout', 'compaction started\nsummary ')
    log.write('host:stderr', 'plugin warning\n')
    log.write('host:stdout', 'requested\n')
    const word = Buffer.from('сжатие прервано\n')
    log.write('host:stderr', word.subarray(0, 3))
    log.write('host:stderr', word.subarray(3))
    log.close()
    expect((await readFile(log.path, 'utf8')).startsWith('app: fixture 1.0.0\n\n')).toBe(true)
    expect(await entries(log)).toEqual([
      '[host:stdout] compaction started',
      '[host:stderr] plugin warning',
      '[host:stdout] summary requested',
      '[host:stderr] сжатие прервано',
    ])
  })

  it('removes terminal color sequences and writes an unterminated line when closed', async () => {
    const log = openLog(await directory())
    log.write('host:stdout', '\u001b[33m[W]\u001b[39m slow request\n')
    log.write('renderer', 'error: last words')
    log.close()
    log.write('main', 'after close\n')
    expect(await entries(log)).toEqual(['[host:stdout] [W] slow request', '[renderer] error: last words'])
  })

  it('stops at its byte cap behind one notice', async () => {
    const log = openLog(await directory(), 200)
    for (let index = 0; index < 20; index += 1) log.write('host:stdout', `line ${String(index)}\n`)
    const lines = await entries(log)
    expect(lines.at(-1)).toBe('[main] run log reached 200 bytes; later output is not recorded')
    expect(lines.filter(line => line.startsWith('[host:stdout]')).length).toBeLessThan(20)
    log.write('host:stdout', 'ignored\n')
    expect(await entries(log)).toEqual(lines)
  })

  it('copies console calls as main output while the original methods keep running, until restored', async () => {
    const log = openLog(await directory())
    const methods = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const target: CapturedConsole = { ...methods }
    const restore = log.captureConsole(target)
    target.warn('forward failed after %d ms', 300_000)
    target.log('plain')
    restore()
    target.error('not copied')
    log.close()
    expect(methods.warn).toHaveBeenCalledWith('forward failed after %d ms', 300_000)
    expect(methods.error).toHaveBeenCalledWith('not copied')
    expect(target.warn).toBe(methods.warn)
    expect(await entries(log)).toEqual(['[main] warn: forward failed after 300000 ms', '[main] plain'])
  })

  it('reports an uncreatable file and returns no log', async () => {
    const root = await directory()
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(RunLog.open(blocked, [])).toBeUndefined()
    expect(error).toHaveBeenCalledWith('dsh desktop: run log could not be created', expect.stringContaining('not-a-directory'), expect.any(Error))
  })

  it('prunes only the oldest run logs beyond the retained count', async () => {
    const root = await directory()
    const logs = Array.from({ length: 12 }, (_, index) => runLogFileName(new Date(Date.UTC(2026, 9, 1 + index))))
    const others = ['crash-2026-10-01T00-00-00-000Z-host.log', 'run-notes.log', 'other.txt']
    await Promise.all([...logs, ...others].map(name => writeFile(join(root, name), '')))
    await pruneRunLogs(root, 10)
    expect((await readdir(root)).sort()).toEqual([...logs.slice(2), ...others].sort())
    await expect(pruneRunLogs(join(root, 'missing'))).resolves.toBeUndefined()
  })
})
