import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import glob from 'fast-glob'
import type { Loader, OnLoadResult, Plugin } from 'esbuild'
import { build, transform } from 'esbuild'
import colors from 'picocolors'
import type { ResolvedConfig } from '..'
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from '../constants'
import {
  cleanUrl,
  createDebugger,
  dataUrlRE,
  externalRE,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { transformGlobImport } from '../plugins/importMetaGlob'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export async function scanImports(config: ResolvedConfig): Promise<{
  deps: Record<string, string>
  missing: Record<string, string>
}> {
  // Only used to scan non-ssr code

  const start = performance.now()

  let entries: string[] = []

  const explicitEntryPatterns = config.optimizeDeps.entries
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    // 没有定义构建入口时，使用项目目录下的 html 文件作为入口
    entries = await globEntries('**/*.html', config)
  }

  // 判定入口是否为 /\.(?:j|t)sx?$|\.mjs$/ 或类 html 模板类型
  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  entries = entries.filter(
    (entry) => isScannable(entry) && fs.existsSync(entry),
  )

  // 没有入口
  if (!entries.length) {
    if (!explicitEntryPatterns && !config.optimizeDeps.include) {
      config.logger.warn(
        colors.yellow(
          '(!) Could not auto-determine entry point from rollupOptions or html files ' +
            'and there are no explicit optimizeDeps.include patterns. ' +
            'Skipping dependency pre-bundling.',
        ),
      )
    }
    return { deps: {}, missing: {} }
  } else {
    debug(`Crawling dependencies using entries:\n  ${entries.join('\n  ')}`)
  }

  const deps: Record<string, string> = {}
  const missing: Record<string, string> = {}
  const container = await createPluginContainer(config)
  // 这里专门定义了一个 scan 插件，用于预构建的build函数，将扫描结果保存到deps、missing这两个对象中
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries)

  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}

  await build({
    absWorkingDir: process.cwd(),
    // NOTE 不进行磁盘IO
    write: false,
    stdin: {
      // NOTE 这里把所有的 entry 都用标准输入stdin + import 语句表示
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join('\n'),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'error',
    // 注入scan插件
    plugins: [...plugins, plugin],
    ...esbuildOptions,
  })

  debug(`Scan completed in ${(performance.now() - start).toFixed(2)}ms:`, deps)

  return {
    // Ensure a fixed order so hashes are stable and improve logs
    deps: orderedDependencies(deps),
    missing,
  }
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  })
}

const scriptModuleRE =
  /(<script\b[^>]+type\s*=\s*(?:"module"|'module')[^>]*>)(.*?)<\/script>/gis
export const scriptRE = /(<script(?:\s[^>]*>|>))(.*?)<\/script>/gis
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i

/**
 * 闭包函数？返回一个对象（vite plugin 实例）
 */
function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[],
): Plugin {
  const seen = new Map<string, string | undefined>()

  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions,
  ) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      },
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  const include = config.optimizeDeps?.include
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env',
  ]

  // 非 entry 时直接标记为 external: true，阻止esbuild继续处理
  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path),
  })

  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader,
  ) => {
    let transpiledContents
    // transpile because `transformGlobImport` only expects js
    if (loader !== 'js') {
      transpiledContents = (await transform(contents, { loader })).code
    } else {
      transpiledContents = contents
    }

    const result = await transformGlobImport(
      transpiledContents,
      id,
      config.root,
      resolve,
      config.isProduction,
    )

    return result?.s.toString() || transpiledContents
  }

  // 其实这里只有三个 onLoad 函数，一个处理类html、一个处理类js、一个处理namesapce="script"
  return {
    name: 'vite:dep-scan',
    setup(build) {
      // scripts，记录类 html 文件解析出来的 script 信息
      const scripts: Record<string, OnLoadResult> = {}

      // external urls（标记为 external 的模块，不会被 onLoad 钩子的回调函数处理，不会被包含在bundle内，运行时引入）
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // data urls
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // 这里的 virtualModule，似乎与 Vue 的单文件组件有关（script部分）
      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          path: path.replace(virtualModulePrefix, ''),
          namespace: 'script',
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'script' }, ({ path }) => {
        // REVIEW 这里是怎么处理的？返回 filter: htmlTypesRE 的 onLoad 函数处理时缓存的结果
        // {loader, contents, pluginData: {htmlType: loader} }
        // pluginData.htmlType 似乎后面有用到了
        return scripts[path]
      })

      // html types: extract script contents -----------------------------------
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        // 调用 container.resolveId（内部执行了所有插件的 revolveId 的 handler，比如 alias 等内置插件）
        const resolved = await resolve(path, importer)
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        if (
          resolved.includes('node_modules') &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return
        return {
          path: resolved,
          namespace: 'html',
        }
      })
      // htmlTypesRE: /\.(html|vue|svelte|astro|imba)$/
      // 注意：.vue 文件也会进入这个 hook
      // extract scripts inside HTML-like files and treat it as a js module
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        async ({ path }) => {
          let raw = fs.readFileSync(path, 'utf-8')
          // Avoid matching the content of the comment
          raw = raw.replace(commentRE, '<!---->')
          const isHtml = path.endsWith('.html')
          const regex = isHtml ? scriptModuleRE : scriptRE
          regex.lastIndex = 0
          let js = ''
          let scriptId = 0
          let match: RegExpExecArray | null
          // 不断尝试匹配文件内容的 script 标签
          while ((match = regex.exec(raw))) {
            const [, openTag, content] = match
            const typeMatch = openTag.match(typeRE)
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
            const langMatch = openTag.match(langRE)
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
            // skip type="application/ld+json" and other non-JS types
            if (
              type &&
              !(
                type.includes('javascript') ||
                type.includes('ecmascript') ||
                type === 'module'
              )
            ) {
              continue
            }
            let loader: Loader = 'js'
            if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
              loader = lang
            } else if (path.endsWith('.astro')) {
              loader = 'ts'
            }
            const srcMatch = openTag.match(srcRE)
            if (srcMatch) {
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
              js += `import ${JSON.stringify(src)}\n`
            } else if (content.trim()) {
              // REVIEW 需要使用虚拟模块的原因：1. Vue文件中存在模块脚本；2. 多个脚本之间需要独立处理，避免变量名重复使用
              // The reason why virtual modules are needed:
              // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
              // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
              // 2. There can be multiple module scripts in html
              // We need to handle these separately in case variable names are reused between them

              // append imports in TS to prevent esbuild from removing them
              // since they may be used in the template
              // 这里用正则表达式提取了script 内的 import 语句（es-moduler-lexer无法处理ts，ACorn太慢，而且这里的处理不需要 Bullet proof）
              // 对 ts 类型的script 内容追加import 语句，强制 esbuild 进一步处理依赖
              const contents =
                content +
                (loader.startsWith('ts') ? extractImportPaths(content) : '')

              const key = `${path}?id=${scriptId++}`
              if (contents.includes('import.meta.glob')) {
                // REVIEW 为什么有import.meta.glob 就改用 js loader？
                // 因为 doTransformGlobImport 先使用 esbuild.transform 把代码编译为 js 了，然后再处理了 import.meta.glob）
                // 缓存该script的解析结果
                scripts[key] = {
                  loader: 'js', // since it is transpiled
                  contents: await doTransformGlobImport(contents, path, loader),
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              } else {
                scripts[key] = {
                  loader,
                  contents,
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              }

              const virtualModulePath = JSON.stringify(
                virtualModulePrefix + key,
              )

              const contextMatch = openTag.match(contextRE)
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3])
              // NOTE 对于 vue 文件等的 script，加载时，将文件内容转换为虚拟模块路径的全量导出语句（export * from vitrualModulePath）
              // svelte的非module script 的 exports有特殊意义？
              // Especially for Svelte files, exports in <script context="module"> means module exports,
              // exports in <script> means component props. To avoid having two same export name from the
              // star exports, we need to ignore exports in <script>
              if (path.endsWith('.svelte') && context !== 'module') {
                js += `import ${virtualModulePath}\n`
              } else {
                js += `export * from ${virtualModulePath}\n`
              }
            }
          }

          // This will trigger incorrectly if `export default` is contained
          // anywhere in a string. Svelte and Astro files can't have
          // `export default` as code so we know if it's encountered it's a
          // false positive (e.g. contained in a string)
          if (!path.endsWith('.vue') || !js.includes('export default')) {
            js += '\nexport default {}'
          }
          // 可以在这里打断点，看到 html 入口类型文件编译成功之后的js内容。之后的content再由esbuild进入新一轮处理？
          // 虚拟模块的import语句又会回到 build.onResolve({ filter: virtualModuleRE }) 这个钩子函数处理
          // 作用：缓存解析结果，避免重复解析？
          return {
            loader: 'js',
            contents: js,
          }
        },
      )
      // 直接引入依赖时如何解析（@vue、react、lodash-es 这样的非绝对路径、非相对路径，或者 alias配置过的路径等等）
      // bare imports: record and externalize ----------------------------------
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/,
        },
        async ({ path: id, importer, pluginData }) => {
          // exclude配置的路径及其子级文件，设为 external
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          // 已经解析过了？
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            // REVIEW 排除非绝对路径 或者 \0 开头的虚拟id（作用是什么？）
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            // 为 node_modules 模块 || 在 include 字段时，记录到优化列表
            if (resolved.includes('node_modules') || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved, config.optimizeDeps)) {
                depImports[id] = resolved
              }
              // 某个依赖被标记为可优化之后，非 entry 则标记为 external，阻止esbuild继续处理
              return externalUnlessEntry({ path: id })
            } else if (isScannable(resolved)) {
              // js类型、类html类型的文件，为scannable
              // 类html类型增加namespace
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace, // html 类型又会进入 html 类型的 onLoad 处理函数，解析script
              }
            } else {
              // 非 nodes_modules/*.[c|m]jsx?，非 include，非 [c|m]jsx?|tsx?，非类html，标记为external
              return externalUnlessEntry({ path: id })
            }
          } else {
            // 无法解析该模块路径
            missing[id] = normalizePath(importer)
          }
        },
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css
      build.onResolve({ filter: CSS_LANGS_RE }, externalUnlessEntry)

      // json & wasm
      build.onResolve({ filter: /\.(json|json5|wasm)$/ }, externalUnlessEntry)

      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`),
        },
        externalUnlessEntry,
      )

      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true,
      }))

      // catch all -------------------------------------------------------------
      // 比如 import some './hello.js' 这种正常的引入方式
      build.onResolve(
        {
          filter: /.*/,
        },
        async ({ path: id, importer, pluginData }) => {
          // use vite resolver to support urls and omitted extensions
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            // 非绝对路径、rollup约定\0开头的虚拟模块、resolved === id（why）|| (非类js、html)
            // 是因为只优化 node_modules 下的依赖的原因吗？
            if (shouldExternalizeDep(resolved, id) || !isScannable(resolved)) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              // 清除了URL中的query和hash参数（正常继续往下走打包流程就可以了）
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        },
      )

      // 对jsx/tsx的引入，只要特殊处理包含 import.meta.glob 的文件，剩下的读取完文件内容，可以交由 esbuild 处理imports关系
      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = fs.readFileSync(id, 'utf-8')
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader)

        if (contents.includes('import.meta.glob')) {
          return {
            loader: 'js', // since it is transpiled,
            contents: await doTransformGlobImport(contents, id, loader),
          }
        }

        return {
          loader,
          contents,
        }
      })
    },
  }
}

/**
 * 使用ts 时，esbuild会忽略 script 模块内部的import语句？不做进一步的依赖获取？
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  importsRE.lastIndex = 0
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`
  }
  return js
}

/**
 * external: true 的判定
 * 1. 解析后不是一个绝对路径
 * 2. rollup插件约定虚拟模块：\0开头
 * 3. import路径本身就是一个绝对路径的时候（why？）
 */
function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string): boolean {
  return JS_TYPES_RE.test(id) || htmlTypesRE.test(id)
}
