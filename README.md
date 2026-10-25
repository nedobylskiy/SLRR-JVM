# SLRR-JVM

**SLRR-JVM interprets selected methods directly from original Street Legal Racing: Redline `.java` source files. It does not execute `.class` bytecode.** In particular, the game's TUFA `.class` format is outside this package. No conversion from `.class` to JavaScript or standard JVM bytecode takes place.

This is an early TypeScript runtime for the Java dialect found in SLRR scripts. It parses selected method bodies and executes them with a step budget and explicit host capabilities. The project is being developed separately from the game-specific renderer, physics, menu, and asset loaders in [SLRR_rev](https://github.com/nedobylskiy/SLRR_rev).

## Try it

```sh
git clone https://github.com/nedobylskiy/SLRR-JVM.git
cd SLRR-JVM
npm ci
npm test
npm run example
```

The example prints `13`. It loads the included synthetic [`Main.java`](examples/java/Main.java), resolves its [`Helper.java`](examples/java/Helper.java) import, and runs a host-registered native function. The example files are small fixtures; **original SLRR game files are not distributed here**. Supply `.java` files from your own installation through the same callbacks.

## Embedding API

```ts
import { readFile } from 'node:fs/promises';
import { SlrrJvm, jv } from 'slrr-jvm';

const files = new Map([
  ['demo.Main', 'examples/java/Main.java'],
  ['demo.Helper', 'examples/java/Helper.java']
]);
const jvm = new SlrrJvm({
  // Decide where each imported Java class lives. This can consult a mod index,
  // load order, game version, or the path of the importing file.
  resolveImport: ({ className, importedBy }) => {
    if (className === 'demo.HostMath') return null; // Host-native class.
    const path = files.get(className);
    return path ? { path } : null;
  },
  readSource: path => readFile(path, 'utf8'),
  selectMethods: className => className === 'demo.Main' ? ['run'] : ['twice']
});

jvm.natives.register('demo.HostMath', 'offset', [], () => jv('int', 3));

await jvm.loadClass('demo.Main');
const main = jvm.construct('demo.Main', []);
const result = jvm.invoke(main, 'run', [jv('int', 5)]);
console.log(result.value); // 13
```

[`examples/basic.ts`](examples/basic.ts) contains a runnable Node.js version of this example. `resolveImport` receives the fully qualified Java class name and optional `importedBy` path. It returns `{ path }`, optionally with `{ source }`; `readSource` is only needed when the resolver does not supply source text. Explicit imports are loaded before method execution, so execution itself is synchronous. A separate `SlrrJvm` instance can use a different resolver to run sources from another game version or mod.

Native methods are **opt-in** host callbacks registered by class, method, and exact argument types. The interpreter exposes no ambient filesystem, DOM, network, or SLRR engine APIs. The embedding application decides which capabilities to provide. Missing imports and native calls raise errors rather than silently succeeding.

## Current limits

- The parser deliberately accepts a subset of the SLRR Java dialect. Callers select methods to parse because unrelated methods in the same original file may still contain unsupported syntax.
- Explicit imports are supported through the callback. Wildcard and static imports are not yet supported.
- Full Java overload resolution, class initialization, a standard library, threads, and the complete SLRR native API are not implemented.
- The runtime is **source-only**. TUFA `.class` parsing and bytecode execution are not part of this package.

`npm run build` produces ESM JavaScript and TypeScript declarations in `dist/`. `npm pack --dry-run` shows the files included in a package archive. The package has not been published to the npm registry.
