/**
 * Run log files: one plain-text log per Desktop launch. It records the Host's stdout and stderr, the
 * shell's own console output, and the primary window's warning- and error-level console messages,
 * each line stamped with its UTC time and origin. Crash reports keep only bounded tails and only for
 * fatal failures; the run log keeps the whole launch, so a failure that leaves the application
 * running, such as a command that ends with an error, can be traced afterwards.
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { format, stripVTControlCharacters } from 'node:util'

/** Where one logged line came from. */
export type RunLogSource = 'host:stdout' | 'host:stderr' | 'main' | 'renderer'

/** File name prefix every run log shares. */
export const RUN_LOG_PREFIX = 'run-'

/** The exact generated file name syntax; pruning touches only files that match it. */
const RUN_LOG_NAME = /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/u

/** Run logs kept after pruning, newest first by file name; the current launch's log counts. */
export const RUN_LOGS_RETAINED = 10

/** Bytes one run log may hold; output after the cap is dropped behind one notice line. */
export const RUN_LOG_MAX_BYTES = 64 * 1024 * 1024

/** The console methods {@link RunLog.captureConsole} copies into the log. */
const CAPTURED_CONSOLE_METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const

/** The part of a console that {@link RunLog.captureConsole} wraps. */
export type CapturedConsole = Pick<Console, typeof CAPTURED_CONSOLE_METHODS[number]>

/**
 * The run log file name: sortable by launch time.
 * @param time - launch time.
 * @returns `run-<ISO time with ':' and '.' as '-'>.log`.
 */
export function runLogFileName(time: Date): string {
  return `${RUN_LOG_PREFIX}${time.toISOString().replaceAll(/[:.]/gu, '-')}.log`
}

/**
 * One launch's run log. Writes are synchronous, so every line written before a crash or an
 * abrupt exit is already in the file. A write failure is reported once through the console
 * methods captured before {@link captureConsole} replaced them, and disables the log for the rest
 * of the launch; the application keeps running without it.
 */
export class RunLog {
  private fd: number | undefined
  private written = 0
  private readonly decoders = new Map<RunLogSource, StringDecoder>()
  private readonly partial = new Map<RunLogSource, string>()
  private reportFailure: (...args: unknown[]) => void = console.error.bind(console)

  private constructor(readonly path: string, fd: number, private readonly maxBytes: number) {
    this.fd = fd
  }

  /**
   * Create this launch's log in `directory`, creating the directory when absent.
   * @param directory - the application logs directory.
   * @param header - facts written as the first lines, such as versions and the process id.
   * @param time - launch time, which names the file.
   * @param maxBytes - byte cap of the file.
   * @returns the open log, or `undefined` when the file cannot be created.
   */
  static open(directory: string, header: readonly string[], time = new Date(), maxBytes = RUN_LOG_MAX_BYTES): RunLog | undefined {
    const path = join(directory, runLogFileName(time))
    let log: RunLog
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      log = new RunLog(path, openSync(path, 'wx', 0o600), maxBytes)
    } catch (error) {
      console.error('dsh desktop: run log could not be created', path, error)
      return undefined
    }
    log.append(`${header.join('\n')}\n\n`)
    return log
  }

  /**
   * Append output from one source. Each complete line is written with its time and source; an
   * incomplete trailing line waits for the rest of its source's output or for {@link close}.
   * @param source - where the output came from.
   * @param chunk - output text, or bytes decoded as UTF-8 across chunk boundaries.
   */
  write(source: RunLogSource, chunk: string | Uint8Array): void {
    if (this.fd === undefined) return
    let text: string
    if (typeof chunk === 'string') text = chunk
    else {
      let decoder = this.decoders.get(source)
      if (decoder === undefined) {
        decoder = new StringDecoder('utf8')
        this.decoders.set(source, decoder)
      }
      text = decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    }
    const lines = `${this.partial.get(source) ?? ''}${text}`.split(/\r?\n/u)
    this.partial.set(source, lines.pop() ?? '')
    if (lines.length > 0) this.append(lines.map(line => this.line(source, line)).join(''))
  }

  /**
   * Copy every later `console` call into this log as source `main`. The original methods still
   * run, and keep reporting this log's own write failure.
   * @param target - the console to wrap, normally the global one.
   * @returns a function restoring the original methods.
   */
  captureConsole(target: CapturedConsole): () => void {
    const originals = CAPTURED_CONSOLE_METHODS.map(method => [method, target[method]] as const)
    this.reportFailure = target.error.bind(target)
    for (const [method, original] of originals) {
      target[method] = (...args: unknown[]): void => {
        original.apply(target, args)
        this.write('main', `${method === 'log' ? '' : `${method}: `}${format(...args)}\n`)
      }
    }
    return () => {
      for (const [method, original] of originals) target[method] = original
    }
  }

  /** Write every incomplete trailing line and close the file; later writes are ignored. */
  close(): void {
    if (this.fd === undefined) return
    const rest = [...this.partial].filter(([, text]) => text.length > 0)
      .map(([source, text]) => this.line(source, text)).join('')
    if (rest.length > 0) this.append(rest)
    this.partial.clear()
    const fd = this.fd
    this.fd = undefined
    try { closeSync(fd) } catch (error) {
      this.reportFailure('dsh desktop: run log could not be closed', this.path, error)
    }
  }

  /** One stamped line; terminal color and cursor sequences are removed because a file cannot render them. */
  private line(source: RunLogSource, text: string): string {
    return `${new Date().toISOString()} [${source}] ${stripVTControlCharacters(text)}\n`
  }

  private append(text: string): void {
    const fd = this.fd
    if (fd === undefined) return
    const bytes = Buffer.from(text)
    try {
      if (this.written + bytes.byteLength > this.maxBytes) {
        writeSync(fd, `${new Date().toISOString()} [main] run log reached ${String(this.maxBytes)} bytes; later output is not recorded\n`)
        this.fd = undefined
        closeSync(fd)
        return
      }
      writeSync(fd, bytes)
      this.written += bytes.byteLength
    } catch (error) {
      this.fd = undefined
      this.reportFailure('dsh desktop: run log write failed; logging stops for this launch', this.path, error)
    }
  }
}

/**
 * Delete the oldest run logs beyond `retained`, judged by file name order, and leave every other
 * file in the directory alone. Failure is reported to `console.error`; a missing directory is not a
 * failure.
 * @param directory - the application logs directory.
 * @param retained - run logs to keep.
 */
export async function pruneRunLogs(directory: string, retained = RUN_LOGS_RETAINED): Promise<void> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    console.error('dsh desktop: run log directory could not be listed', directory, error)
    return
  }
  const logs = names.filter(name => RUN_LOG_NAME.test(name)).sort()
  for (const name of logs.slice(0, Math.max(0, logs.length - retained))) {
    try {
      await unlink(join(directory, name))
    } catch (error) {
      console.error('dsh desktop: stale run log could not be removed', join(directory, name), error)
    }
  }
}
