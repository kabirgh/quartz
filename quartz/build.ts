import sourceMapSupport from "source-map-support"
sourceMapSupport.install(options)
import path from "path"
import { PerfTimer } from "./util/perf"
import { rimraf } from "rimraf"
import { GlobbyFilterFunction, isGitIgnored } from "globby"
import chalk from "chalk"
import { parseMarkdown } from "./processors/parse"
import { filterContent } from "./processors/filter"
import { emitContent } from "./processors/emit"
import cfg from "../quartz.config"
import { FilePath, FullSlug, joinSegments, slugifyFilePath } from "./util/path"
import chokidar from "chokidar"
import { ProcessedContent } from "./plugins/vfile"
import { Argv, BuildCtx } from "./util/ctx"
import { glob, toPosixPath } from "./util/glob"
import { trace } from "./util/trace"
import { options } from "./util/sourcemap"
import { Mutex } from "async-mutex"
import DepGraph from "./depgraph"
import { getStaticResourcesFromPlugins } from "./plugins"

type BuildData = {
  ctx: BuildCtx
  ignored: GlobbyFilterFunction
  mut: Mutex
  initialSlugs: FullSlug[]
  contentMap: Map<FilePath, ProcessedContent>
  trackedAssets: Set<FilePath>
  lastBuildMs: number
  depGraphs: Record<string, DepGraph>
}

type FileEvent = "add" | "change" | "delete"

async function buildQuartz(argv: Argv, mut: Mutex, clientRefresh: () => void) {
  const ctx: BuildCtx = {
    argv,
    cfg,
    allSlugs: [],
  }

  const perf = new PerfTimer()
  const output = argv.output

  const pluginCount = Object.values(cfg.plugins).flat().length
  const pluginNames = (key: "transformers" | "filters" | "emitters") =>
    cfg.plugins[key].map((plugin) => plugin.name)
  if (argv.verbose) {
    console.log(`Loaded ${pluginCount} plugins`)
    console.log(`  Transformers: ${pluginNames("transformers").join(", ")}`)
    console.log(`  Filters: ${pluginNames("filters").join(", ")}`)
    console.log(`  Emitters: ${pluginNames("emitters").join(", ")}`)
  }

  const release = await mut.acquire()
  perf.addEvent("clean")
  await rimraf(output)
  console.log(`Cleaned output directory \`${output}\` in ${perf.timeSince("clean")}`)

  perf.addEvent("glob")
  const allFiles = await glob("**/*.*", argv.directory, cfg.configuration.ignorePatterns)
  const fps = allFiles.filter((fp) => fp.endsWith(".md")).sort()
  console.log(
    `Found ${fps.length} input files from \`${argv.directory}\` in ${perf.timeSince("glob")}`,
  )

  const filePaths = fps.map((fp) => joinSegments(argv.directory, fp) as FilePath)
  ctx.allSlugs = allFiles.map((fp) => slugifyFilePath(fp as FilePath))

  const parsedFiles = await parseMarkdown(ctx, filePaths)
  const filteredContent = filterContent(ctx, parsedFiles)

  const depGraphs: Record<string, DepGraph> = {}
  const staticResources = getStaticResourcesFromPlugins(ctx)
  for (const emitter of cfg.plugins.emitters) {
    const emitterGraph = await emitter.getDependencyGraph(ctx, filteredContent, staticResources)
    depGraphs[emitter.name] = emitterGraph
  }

  await emitContent(ctx, filteredContent)
  console.log(chalk.green(`Done processing ${fps.length} files in ${perf.timeSince()}`))
  release()

  if (argv.serve) {
    return startServing(ctx, mut, parsedFiles, clientRefresh, depGraphs)
  }
}

// setup watcher for rebuilds
async function startServing(
  ctx: BuildCtx,
  mut: Mutex,
  initialContent: ProcessedContent[],
  clientRefresh: () => void,
  depGraphs: Record<string, DepGraph>, // emitter name: dep graph
) {
  const { argv } = ctx

  // cache file parse results
  const contentMap = new Map<FilePath, ProcessedContent>()
  for (const content of initialContent) {
    const [_tree, vfile] = content
    contentMap.set(vfile.data.filePath!, content)
  }

  const buildData: BuildData = {
    ctx,
    mut,
    depGraphs,
    contentMap,
    ignored: await isGitIgnored(),
    initialSlugs: ctx.allSlugs,
    trackedAssets: new Set<FilePath>(),
    lastBuildMs: 0,
  }

  const watcher = chokidar.watch(".", {
    persistent: true,
    cwd: argv.directory,
    ignoreInitial: true,
  })

  if (argv.fastRebuild) {
    watcher
      .on("add", (fp) => partialRebuild(fp, "add", clientRefresh, buildData))
      .on("change", (fp) => partialRebuild(fp, "change", clientRefresh, buildData))
      .on("unlink", (fp) => partialRebuild(fp, "delete", clientRefresh, buildData))
  } else {
    watcher
      .on("add", (fp) => rebuild(fp, "add", clientRefresh, buildData))
      .on("change", (fp) => rebuild(fp, "change", clientRefresh, buildData))
      .on("unlink", (fp) => rebuild(fp, "delete", clientRefresh, buildData))
  }

  return async () => {
    await watcher.close()
  }
}

export async function partialRebuild(
  filepath: string,
  action: FileEvent,
  clientRefresh: () => void,
  buildData: BuildData, // note: this function mutates buildData
) {
  const { ctx, ignored, depGraphs, contentMap } = buildData
  const { argv, cfg } = ctx

  // don't do anything for gitignored files
  if (ignored(filepath)) {
    return
  }

  const perf = new PerfTimer()
  console.log(chalk.yellow("Detected change, rebuilding..."))

  // UPDATE DEP GRAPH
  const fp = joinSegments(argv.directory, toPosixPath(filepath)) as FilePath

  const staticResources = getStaticResourcesFromPlugins(ctx)
  let processedFile: ProcessedContent

  switch (action) {
    case "add":
      // add to cache when new file is added
      processedFile = (await parseMarkdown(ctx, [fp]))[0]
      contentMap.set(fp, processedFile)

      // update the dep graph by asking all emitters whether they depend on this file
      for (const emitter of cfg.plugins.emitters) {
        const emitterGraph = await emitter.getDependencyGraph(ctx, [processedFile], staticResources)
        depGraphs[emitter.name] = emitterGraph
      }
      break
    case "change":
      // invalidate cache when file is changed
      processedFile = (await parseMarkdown(ctx, [fp]))[0]
      contentMap.set(fp, processedFile)

      // only content files can have added/removed dependencies because of transclusions
      if (path.extname(fp) === ".md") {
        for (const emitter of cfg.plugins.emitters) {
          // get new dependencies from all emitters for this file
          const emitterGraph = await emitter.getDependencyGraph(
            ctx,
            [processedFile],
            staticResources,
          )
          // merge the new dependencies into the dep graph
          depGraphs[emitter.name].mergeEdgesForNode(emitterGraph, fp)
        }
      }
      break
    case "delete":
      // remove from cache when file is deleted
      contentMap.delete(fp)

      // remove the node from the graph
      // we don't need to call the emitters again because file deletion cannot affect other files dependencies
      Object.values(depGraphs).forEach((depGraph) => depGraph.removeNode(fp))
      break
  }

  if (argv.verbose) {
    console.log(`Updated dependency graphs in ${perf.timeSince()}`)
  }

  // EMIT
  perf.addEvent("rebuild")
  let emittedFiles = 0

  for (const emitter of cfg.plugins.emitters) {
    const depGraph = depGraphs[emitter.name]

    // only call the emitter if it uses this file
    if (depGraph.hasNode(fp)) {
      // re-emit using all files that are needed for the downstream of this file
      // eg. for ContentIndex, the dep graph could be:
      // a.md --> contentIndex.json
      // b.md ------^
      //
      // if a.md changes, we need to re-emit contentIndex.json,
      // and supply [a.md, b.md] to the emitter
      const upstreams = [...depGraph.getUpstreamsOfDownstreamLeafNodes(fp)] as FilePath[]
      const upstreamContent = upstreams
        // filter out non-markdown files
        .filter((file) => contentMap.has(file))
        .map((file) => contentMap.get(file)!)

      const emittedFps = await emitter.emit(ctx, upstreamContent, staticResources)

      if (ctx.argv.verbose) {
        for (const file of emittedFps) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }

      emittedFiles += emittedFps.length
    }
  }

  console.log(`Emitted ${emittedFiles} files to \`${argv.output}\` in ${perf.timeSince("rebuild")}`)

  clientRefresh()
}

export async function rebuild(
  fp: string,
  action: FileEvent,
  clientRefresh: () => void,
  buildData: BuildData, // note: this function mutates buildData
) {
  const { ctx, ignored, mut, initialSlugs, contentMap, trackedAssets, lastBuildMs } = buildData

  const { argv } = ctx

  const toRebuild = new Set<FilePath>()
  const toRemove = new Set<FilePath>()

  // don't do anything for gitignored files
  if (ignored(fp)) {
    return
  }

  // dont bother rebuilding for non-content files, just track and refresh
  fp = toPosixPath(fp)
  const filePath = joinSegments(argv.directory, fp) as FilePath
  if (path.extname(fp) !== ".md") {
    if (action === "add" || action === "change") {
      trackedAssets.add(filePath)
    } else if (action === "delete") {
      trackedAssets.delete(filePath)
    }
    clientRefresh()
    return
  }

  if (action === "add" || action === "change") {
    toRebuild.add(filePath)
  } else if (action === "delete") {
    toRemove.add(filePath)
  }

  // debounce rebuilds every 250ms

  const buildStart = new Date().getTime()
  buildData.lastBuildMs = buildStart
  const release = await mut.acquire()
  if (lastBuildMs > buildStart) {
    release()
    return
  }

  const perf = new PerfTimer()
  console.log(chalk.yellow("Detected change, rebuilding..."))
  try {
    const filesToRebuild = [...toRebuild].filter((fp) => !toRemove.has(fp))

    const trackedSlugs = [...new Set([...contentMap.keys(), ...toRebuild, ...trackedAssets])]
      .filter((fp) => !toRemove.has(fp))
      .map((fp) => slugifyFilePath(path.posix.relative(argv.directory, fp) as FilePath))

    ctx.allSlugs = [...new Set([...initialSlugs, ...trackedSlugs])]
    const parsedContent = await parseMarkdown(ctx, filesToRebuild)
    for (const content of parsedContent) {
      const [_tree, vfile] = content
      contentMap.set(vfile.data.filePath!, content)
    }

    for (const fp of toRemove) {
      contentMap.delete(fp)
    }

    const parsedFiles = [...contentMap.values()]
    const filteredContent = filterContent(ctx, parsedFiles)

    // TODO: we can probably traverse the link graph to figure out what's safe to delete here
    // instead of just deleting everything
    await rimraf(argv.output)
    await emitContent(ctx, filteredContent)
    console.log(chalk.green(`Done rebuilding in ${perf.timeSince()}`))
  } catch (err) {
    console.log(chalk.yellow(`Rebuild failed. Waiting on a change to fix the error...`))
    if (argv.verbose) {
      console.log(chalk.red(err))
    }
  }

  release()
  clientRefresh()
}

export default async (argv: Argv, mut: Mutex, clientRefresh: () => void) => {
  try {
    return await buildQuartz(argv, mut, clientRefresh)
  } catch (err) {
    trace("\nExiting Quartz due to a fatal error", err as Error)
  }
}
