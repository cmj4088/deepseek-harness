/** Junction-scan regression: the HMR watcher must not follow reparse-point cycles. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Hmr from '../src/index.ts'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { FSWatcher, type ChokidarOptions } from 'chokidar'

// Capture the options HMR hands to Chokidar when the service opens its module
// watcher; pass through to the real watcher unless a case installs a factory.
type WatchFactory = (paths: string | string[], options?: ChokidarOptions) => FSWatcher
const capture = vi.hoisted(() => ({ create: undefined as WatchFactory | undefined }))
vi.mock('chokidar', async (importOriginal) => {
  const native = await importOriginal<typeof import('chokidar')>()
  return { ...native, watch: (paths: string | string[], options?: ChokidarOptions) =>
    capture.create === undefined ? native.watch(paths, options) : capture.create(paths, options) }
})

afterEach(() => { capture.create = undefined })

/** Production default ignore patterns, matching Hmr.Config's `ignored` defaults. */
const PRODUCTION_IGNORED = ['**/node_modules', '**/.*', 'cache', 'data']

async function bootHmr(dir: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: ['.'], ignored: [], debounce: 0, ...overrides })
  return ctx
}

describe('HMR junction-scan containment', () => {
  it('watches the module root without following symlinks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-symlink-opt-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    const started = Promise.withResolvers<ChokidarOptions>()
    capture.create = (paths, options) => {
      started.resolve(options ?? {})
      // watch() = new FSWatcher(options) + add(paths); mirror both steps.
      const watcher = new FSWatcher(options)
      queueMicrotask(() => { watcher.emit('ready') })
      void watcher.add(paths)
      return watcher
    }
    const ctx = await bootHmr(dir)
    onTestFinished(() => ctx.fiber.dispose())
    // The service opens its watcher during [Service.init]; the captured options
    // must tell Chokidar never to descend through junctions or symlinks.
    expect((await started.promise).followSymlinks).toBe(false)
  })

  it('matches ignored directories across Windows path separators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-winsep-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    const started = Promise.withResolvers<ChokidarOptions>()
    capture.create = (paths, options) => {
      started.resolve(options ?? {})
      // watch() = new FSWatcher(options) + add(paths); mirror both steps.
      const watcher = new FSWatcher(options)
      queueMicrotask(() => { watcher.emit('ready') })
      void watcher.add(paths)
      return watcher
    }
    const ctx = await bootHmr(dir, { ignored: PRODUCTION_IGNORED })
    onTestFinished(() => ctx.fiber.dispose())
    const ignored = (await started.promise).ignored
    if (typeof ignored !== 'function') throw new Error('Expected an ignored predicate')
    // A backslash path under the watch base, as Windows `relative()` emits it:
    // `**/node_modules` must match regardless of the separator in the path.
    const base = realpathSync(dir)
    expect(ignored(`${base}\\project\\node_modules`)).toBe(true)
    expect(ignored(`${base}\\project\\src\\module.ts`)).toBe(false)
  })

  it('finishes the initial scan over a node_modules junction cycle', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-cycle-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    // A cycle rooted inside node_modules: pkg/loop-back points at the watch root.
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '')
    symlinkSync(dir, join(dir, 'node_modules', 'pkg', 'loop-back'),
      process.platform === 'win32' ? 'junction' : 'dir')
    const ready = Promise.withResolvers<undefined>()
    capture.create = (paths, options) => {
      // watch() = new FSWatcher(options) + add(paths); mirror both steps.
      const watcher = new FSWatcher(options)
      watcher.once('ready', () => { ready.resolve(undefined) })
      void watcher.add(paths)
      return watcher
    }
    const ctx = await bootHmr(dir, { ignored: PRODUCTION_IGNORED })
    onTestFinished(() => ctx.fiber.dispose())
    // With symlink following enabled this ready signal never arrives: Chokidar
    // walks the cycle forever. The case budget above fails when it hangs.
    await ready.promise
  })
})
