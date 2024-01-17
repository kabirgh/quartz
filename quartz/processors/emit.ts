import path from "path"
import fs from "fs"
import { PerfTimer } from "../util/perf"
import { getStaticResourcesFromPlugins } from "../plugins"
import { EmitCallback } from "../plugins/types"
import { ProcessedContent } from "../plugins/vfile"
import { FilePath, joinSegments } from "../util/path"
import { QuartzLogger } from "../util/log"
import { trace } from "../util/trace"
import { BuildCtx } from "../util/ctx"
import { DependencyGraph } from "../util/types"
import { rimraf } from "rimraf"

export async function incrementalEmit(
  ctx: BuildCtx,
  content: ProcessedContent[],
  fp: string,
  dependencyGraph: DependencyGraph,
) {
  const { argv, cfg } = ctx

  const destNodes = dependencyGraph[fp]

  // If this file doesn't have any destinations, something has gone wrong.
  // Log and re-emit everything.
  if (!destNodes) {
    console.log(`${fp} not in dependency graph. Running all emitters...`)
    if (ctx.argv.verbose) {
      console.log("Deleting all files in output directory")
    }
    await rimraf(argv.output)
    return emitContent(ctx, content)
  }

  const filesToDelete = destNodes.map((node) => node.destinations).flat()
  if (ctx.argv.verbose) {
    console.log(`[build] Deleting files: ${filesToDelete.join(", ")}`)
  }
  await rimraf(filesToDelete)

  const emitterNames = destNodes.map((node) => node.emitterName)
  const emittersToRun = cfg.plugins.emitters.filter((e) => emitterNames.includes(e.name))

  // TODO de-dupe with emitContent
  const emit: EmitCallback = async ({ slug, ext, content }) => {
    const pathToPage = joinSegments(argv.output, slug + ext) as FilePath
    const dir = path.dirname(pathToPage)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(pathToPage, content)
    return pathToPage
  }

  let emittedFiles = 0
  const staticResources = getStaticResourcesFromPlugins(ctx)
  for (const emitter of emittersToRun) {
    try {
      const emitted = await emitter.emit(ctx, content, staticResources, emit)
      emittedFiles += emitted.length

      if (ctx.argv.verbose) {
        for (const file of emitted) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    } catch (err) {
      trace(`Failed to emit from plugin \`${emitter.name}\``, err as Error)
    }
  }
}

export async function emitContent(ctx: BuildCtx, content: ProcessedContent[]) {
  const { argv, cfg } = ctx
  const perf = new PerfTimer()
  const log = new QuartzLogger(ctx.argv.verbose)

  log.start(`Emitting output files`)
  const emit: EmitCallback = async ({ slug, ext, content }) => {
    const pathToPage = joinSegments(argv.output, slug + ext) as FilePath
    const dir = path.dirname(pathToPage)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(pathToPage, content)
    return pathToPage
  }

  let emittedFiles = 0
  const staticResources = getStaticResourcesFromPlugins(ctx)
  for (const emitter of cfg.plugins.emitters) {
    try {
      const emitted = await emitter.emit(ctx, content, staticResources, emit)
      emittedFiles += emitted.length

      if (ctx.argv.verbose) {
        for (const file of emitted) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    } catch (err) {
      trace(`Failed to emit from plugin \`${emitter.name}\``, err as Error)
    }
  }

  log.end(`Emitted ${emittedFiles} files to \`${argv.output}\` in ${perf.timeSince()}`)
}
