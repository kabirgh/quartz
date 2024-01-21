---
title: Partial rebuilds in Quartz
---

# 1. Build dependency graph

When building files for the first time, call emitter.fileDependencies() for all emitters to get a mapping of source file paths to files written.

```
{a.md -> [a.html]}
or
{a.md -> [contentIndex.json], b.md -> [contentIndex.json]}
```

The build method merges the maps from all emitters to create a dependency graph.

```
a.md --contentPage--> a.html
b.md --contentPage--> b.html

a.md --contentIndex--> contentIndex.json
b.md --contentIndex--> contentIndex.json
```

Alternatively: we maintain a separate graph for each emitter, which is simpler to implement.

# 2. Rebuild on change

## Change in source file

When a source file changes:

1. Look up the file in the dependency graph.
2. Delete all the destinations for that file.
3. Run the emitters that use that file.

### Transclusion handling

Let's take and example: a.md transcludes b.md via `![[b.md]]`

So graph is:
b.md -> a.md -> a.html
b.md -> b.html

If b.md changes, downstreams are [b.html, a.html]

## New source file

When a new source file is added:

1. With this file, call emitter.fileDependencies() for all emitters to get a mapping of source file paths to files written.
2. Update the dependency graph by merging fileDependencies for this file.
3. Delete all the destinations for that file.
4. Run the emitters that use that file.

## File deleted

When a source file is deleted:

1. Look up the file in the dependency graph.
2. Delete all the destinations for that file.
3. Remove the file from the dependency graph.

## File renames

Treat as delete + create -- simple because chokidar emits unlink and add when a file is renamed.

# TODOs

- [ ] fileDependencies() for emitters; especially aliases, tags, folderpage
- [ ] transclusions
- [ ] sitemap, index.xml, contentIndex need all files supplied not just one

# Scratchpad / notes

## contentIndex handling

graph:

a.md --contentPage--> a.html
b.md --contentPage--> b.html

a.md --contentIndex--> contentIndex.json
b.md --contentIndex--> contentIndex.json

Builder:
give all upstream of downstream files to emitter
egs.

- contentPage: a.md changed; downstream a.html, no other upstreams, so give a.md to contentPage emitter
- contentIndex: a.md changed; downstream contentIndex.json, upstream a.md & b.md, so give a.md & b.md to contentIndex emitter

## steps

prepare code for incremental rebuilds

1. [ ] move build into separate function outside of startServing.

The approach to full and partial rebuild functions will be different enough that they should be different functions.This allows us to switch from

```ts
watcher.on("add", (fp) => rebuild(fp, "add"))
```

to

```ts
if (argv.partial) {
  watcher.on("add", (fp) => partialRebuild(fp, "add", buildData))
} else {
  watcher.on("add", (fp) => fullRebuild(fp, "add", buildData))
}
```

2. TODO...
