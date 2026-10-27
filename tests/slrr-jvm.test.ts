import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlrrJvm, jv, parseSourceClass } from 'slrr-jvm';

test('source package resolves Java imports through a host callback and dispatches a registered native', async () => {
  const sources = new Map([
    ['game/Main.java', `package game;
      import game.Helper;
      import game.HostMath;
      class Main {
        int offset;
        Main() { offset = 2; }
        int run(int n) { return Helper.twice(n) + HostMath.bump(offset); }
      }`],
    ['game/Helper.java', `package game;
      class Helper { static int twice(int n) { return n * 2; } }`]
  ]);
  const requests: string[] = [];
  const runtime = new SlrrJvm({
    resolveImport: ({ className, importedBy }) => {
      requests.push(`${className}:${importedBy ?? 'entry'}`);
      return className === 'game.HostMath' ? null : { path: `${className.replaceAll('.', '/')}.java` };
    },
    readSource: path => {
      const source = sources.get(path);
      if (!source) throw new Error(`Missing fixture ${path}`);
      return source;
    },
    selectMethods: name => name === 'game.Main' ? ['Main', 'run'] : ['twice']
  });
  runtime.natives.register('game.HostMath', 'bump', ['int'], ({ args }) => jv('int', Number(args[0].value) + 1));
  await Promise.all([runtime.loadClass('game.Main'), runtime.loadClass('game.Main')]);
  const main = runtime.construct('game.Main', []);
  assert.equal(runtime.invoke(main, 'run', [jv('int', 5)]).value, 13);
  assert.deepEqual(requests, ['game.Main:entry', 'game.Helper:game/Main.java', 'game.HostMath:game/Main.java']);
});

test('unresolved imports and unregistered native calls fail explicitly', async () => {
  const source = `package game; import game.Missing; class Main { int run() { return Missing.value(); } }`;
  const runtime = new SlrrJvm({
    resolveImport: ({ className }) => className === 'game.Main' ? { path: 'Main.java', source } : null,
    selectMethods: () => ['run']
  });
  await assert.rejects(runtime.loadClass('game.Main'), /Java import unresolved: game.Missing/);

  const native = new SlrrJvm({
    resolveImport: () => ({ path: 'Main.java', source: 'class Main { int run() { return missing(); } }' }),
    selectMethods: () => ['run']
  });
  await native.loadClass('Main');
  assert.throws(() => native.invoke(native.construct('Main', []), 'run'), /Java method\/native missing: Main.missing/);
});

test('separate resolvers select different Java versions without changing the runtime', async () => {
  const main = 'package game; import game.Config; class Main { int run() { return Config.version(); } }';
  const run = async (version: number) => {
    const jvm = new SlrrJvm({
      resolveImport: ({ className }) => className === 'game.Main'
        ? { path: 'game/Main.java', source: main }
        : { path: `mods/v${version}/Config.java`, source: `package game; class Config { static int version() { return ${version}; } }` },
      selectMethods: () => ['run', 'version']
    });
    await jvm.loadClass('game.Main');
    return jvm.invoke(jvm.construct('game.Main', []), 'run').value;
  };
  assert.equal(await run(1), 1);
  assert.equal(await run(2), 2);
});

test('shared SLRR parser executes do/while, compound updates and qualified resource IDs', async () => {
  const source = `package demo;
    class Flow {
      int run() {
        int n = 0;
        do { n += 2; } while (n < 4);
        for (int i = 0; i < 2; i++, n += 1) { }
        return n;
      }
      ResourceRef id() {
        ResourceRef value = parts.engines.M20B25:0x05r;
        return value;
      }
    }`;
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => className === 'demo.Flow' ? { path: 'Flow.java', source } : null,
    selectMethods: () => ['run', 'id']
  });
  await jvm.loadClass('demo.Flow');
  const instance = jvm.construct('demo.Flow', []);
  assert.equal(jvm.invoke(instance, 'run').value, 6);
  assert.deepEqual(jvm.invoke(instance, 'id').value, { pack: 'parts.engines.M20B25', id: 5 });
});

test('a source with several classes selects and executes the requested class', async () => {
  const source = `package demo;
    class Main { int enter() { return 1; } }
    class Gates { int show() { return 40 + 2; } }`;
  assert.equal(parseSourceClass(source, new Set(['show']), 'Gates').methods[0].name, 'show');
  const jvm = new SlrrJvm({
    resolveImport: () => ({ path: 'Main.java', source }),
    selectMethods: () => ['show']
  });
  await jvm.loadClass('demo.Gates');
  assert.equal(jvm.invoke(jvm.construct('demo.Gates', []), 'show').value, 42);
});

test('wildcard imports are resolved from classes actually referenced in source', async () => {
  const main = 'package demo; import demo.helpers.*; class Main { int run() { return Helper.twice(4); } }';
  const helper = 'package demo.helpers; class Helper { static int twice(int x) { return x * 2; } }';
  const requested: string[] = [];
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => {
      requested.push(className);
      if (className === 'demo.Main') return { path: 'Main.java', source: main };
      if (className === 'demo.helpers.Helper') return { path: 'Helper.java', source: helper };
      return null;
    },
    selectMethods: () => ['run', 'twice']
  });
  await jvm.loadClass('demo.Main');
  assert.equal(jvm.invoke(jvm.construct('demo.Main', []), 'run').value, 8);
  assert.ok(requested.includes('demo.helpers.Helper'));
});

test('source overloads choose the closest argument types', async () => {
  const source = `class Overloads {
    int pick(int x) { return 11; }
    int pick(float x) { return 22; }
    int run() { return pick(3) + pick(3.5); }
  }`;
  const jvm = new SlrrJvm({ resolveImport: () => ({ path: 'Overloads.java', source }) });
  await jvm.loadClass('Overloads');
  assert.equal(jvm.invoke(jvm.construct('Overloads', []), 'run').value, 33);
});

test('static fields initialize once and remain shared between instances', async () => {
  const source = `class Counter {
    static int count = 2;
    int next() { count += 1; return count; }
    static int current() { return count; }
  }`;
  const jvm = new SlrrJvm({ resolveImport: () => ({ path: 'Counter.java', source }) });
  await jvm.loadClass('Counter');
  const first = jvm.construct('Counter', []), second = jvm.construct('Counter', []);
  assert.equal(jvm.invoke(first, 'next').value, 3);
  assert.equal(jvm.invoke(second, 'next').value, 4);
  assert.equal(jvm.invoke(jv('class', 'Counter'), 'current').value, 4);
});

test('super constructor executes source parent and can dispatch to a native parent', async () => {
  const source = `package demo;
    class Base { int value; Base(int x) { value = x; } }
    class Child extends Base { Child() { super(7); } int get() { return value; } int isBase() { return this instanceof Base; } }`;
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => className === 'demo.Child' ? { path: 'Family.java', source } : null
  });
  await jvm.loadClass('demo.Child');
  const child = jvm.construct('demo.Child', []);
  assert.equal(jvm.invoke(child, 'get').value, 7);
  assert.equal(jvm.invoke(child, 'isBase').value, 1);

  let seen = 0;
  const nativeSource = 'package demo; import demo.NativeBase; class NativeChild extends NativeBase { NativeChild(int x) { super(x); } }';
  const nativeJvm = new SlrrJvm({
    resolveImport: ({ className }) => className === 'demo.NativeChild' ? { path: 'NativeChild.java', source: nativeSource } : null
  });
  nativeJvm.natives.register('demo.NativeBase', '<init>', ['int'], ({ args }) => { seen = Number(args[0].value); return jv('void', undefined); });
  await nativeJvm.loadClass('demo.NativeChild');
  nativeJvm.construct('demo.NativeChild', [jv('int', 9)]);
  assert.equal(seen, 9);
});

test('child field initializers run after the parent constructor', async () => {
  const source = `package demo;
    class Base { int x = 1; Base() { x = 2; } }
    class Child extends Base {
      int y = x;
      Child() { super(); y += 1; }
      int value() { return y; }
    }`;
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => className === 'demo.Child' ? { path: 'Family.java', source } : null
  });
  await jvm.loadClass('demo.Child');
  assert.equal(jvm.invoke(jvm.construct('demo.Child', []), 'value').value, 3);
});

test('this constructor chaining initializes instance fields once', async () => {
  const source = `class Chain {
    int x = 1;
    Chain() { this(3); x += 1; }
    Chain(int n) { x = n; }
    int get() { return x; }
  }`;
  const jvm = new SlrrJvm({ resolveImport: () => ({ path: 'Chain.java', source }) });
  await jvm.loadClass('Chain');
  assert.equal(jvm.invoke(jvm.construct('Chain', []), 'get').value, 4);
});

test('new on a host-native class uses its registered constructor and instance methods', async () => {
  const source = 'package demo; import demo.Host; class Main { int run() { return new Host(5).twice(); } }';
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => className === 'demo.Main' ? { path: 'Main.java', source } : null
  });
  jvm.natives.register('demo.Host', '<init>', ['int'], ({ args }) => jv('demo.Host', { x: Number(args[0].value) }));
  jvm.natives.register('demo.Host', 'twice', [], ({ receiver }) => jv('int', Number((receiver.value as { x: number }).x) * 2));
  await jvm.loadClass('demo.Main');
  assert.equal(jvm.invoke(jvm.construct('demo.Main', []), 'run').value, 10);
});

test('java.lang native parents and fields resolve implicitly, and arrays expose length', async () => {
  const source = `package demo; class Child extends NativeBase {
    Child() { ping(); }
    int read() { int[] values = new int[3]; return Host.VALUE + values.length; }
  }`;
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => className === 'demo.Child' ? { path: 'Child.java', source } : null,
  });
  let pinged = false;
  jvm.natives.register('java.lang.NativeBase', '<init>', [], () => jv('void', undefined));
  jvm.natives.register('java.lang.NativeBase', 'ping', [], () => { pinged = true; return jv('void', undefined); });
  jvm.natives.registerField('java.lang.Host', 'VALUE', jv('int', 2));
  await jvm.loadClass('demo.Child');
  const child = jvm.construct('demo.Child', []);
  assert.equal(pinged, true);
  assert.equal(jvm.invoke(child, 'read').value, 5);
  jvm.set(jv('class', 'java.lang.Host'), 'VALUE', jv('int', 4));
  assert.equal(jvm.invoke(child, 'read').value, 7);
});

test('a sibling class in the same source file runs its constructor', async () => {
  const source = `package demo; class Main {
    int read() { Goal goal = new Goal(7); return goal.flag; }
  } class Goal { int flag; Goal(int value) { flag = value; } }`;
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => className === 'demo.Main' ? { path: 'Main.java', source } : null,
    selectMethods: className => className === 'demo.Main' ? ['read'] : [className.split('.').at(-1)!],
  });
  await jvm.loadClass('demo.Main');
  assert.equal(jvm.invoke(jvm.construct('demo.Main', []), 'read').value, 7);
});

test('runtime errors identify the failing expression line', async () => {
  const source = `package demo;
class Main {
  void run() {
    missing();
  }
}`;
  const jvm = new SlrrJvm({ resolveImport: ({ className }) => className === 'demo.Main' ? { path: 'Main.java', source } : null });
  await jvm.loadClass('demo.Main');
  assert.throws(() => jvm.invoke(jvm.construct('demo.Main', []), 'run'), /Main\.run \(source line 4\): Java method\/native missing: demo\.Main\.missing/);
});

test('a referenced class resolves from the current package without an import', async () => {
  const sources = new Map([
    ['demo/Main.java', 'package demo; class Main { int run() { return City.VALUE; } }'],
    ['demo/City.java', 'package demo; class City { static int VALUE = 17; }'],
  ]);
  const jvm = new SlrrJvm({
    resolveImport: ({ className }) => {
      const path = `${className.replaceAll('.', '/')}.java`;
      return sources.has(path) ? { path, source: sources.get(path) } : null;
    },
  });
  await jvm.loadClass('demo.Main');
  assert.equal(jvm.invoke(jvm.construct('demo.Main', []), 'run').value, 17);
});

test('static field failures identify the declaring class and source line', async () => {
  const source = `package demo;
class Main {
  static Vector3 CENTER = new Vector3();
}`;
  const jvm = new SlrrJvm({ resolveImport: ({ className }) => className === 'demo.Main' ? { path: 'Main.java', source } : null });
  await jvm.loadClass('demo.Main');
  assert.throws(() => jvm.get(jv('class', 'demo.Main'), 'CENTER'),
    /Main\.<fields> \(source line 3\): Java constructor\/native missing: Vector3\(\)/);
});

test('an explicit super call reaches implicit java.lang.Object', async () => {
  const source = 'package java.lang; class Native { Native() { super(); } }';
  const jvm = new SlrrJvm({ resolveImport: ({ className }) => className === 'java.lang.Native' ? { path: 'Native.java', source } : null });
  await jvm.loadClass('java.lang.Native');
  assert.equal(jvm.construct('java.lang.Native', []).type, 'Native');
});

test('a resource literal exposes its type ID to source constructors', async () => {
  const source = 'package demo; class Main { int read() { ResourceRef ref = system:0x1br; return ref.typeID; } }';
  const jvm = new SlrrJvm({ resolveImport: ({ className }) => className === 'demo.Main' ? { path: 'Main.java', source } : null });
  await jvm.loadClass('demo.Main');
  assert.equal(jvm.invoke(jvm.construct('demo.Main', []), 'read').value, 0x1b);
});

test('a missing native implementation is distinguished from a missing Java method', async () => {
  const source = 'package demo; class Base { native void setFlags(int flags); } class Child extends Base { void run() { setFlags(1); } }';
  const jvm = new SlrrJvm({ resolveImport: ({ className }) => ['demo.Base', 'demo.Child'].includes(className) ? { path: 'Types.java', source } : null });
  await jvm.loadClass('demo.Child');
  assert.throws(() => jvm.invoke(jvm.construct('demo.Child', []), 'run'),
    /Java native implementation missing: demo\.Base\.setFlags\(int\)/);
});

test('null can match a reference parameter in a registered native', async () => {
  const source = 'package demo; import demo.Host; class Main { int run() { return Host.read(null); } }';
  const jvm = new SlrrJvm({ resolveImport: ({ className }) => className === 'demo.Main' ? { path: 'Main.java', source } : null });
  jvm.natives.register('demo.Host', 'read', ['String'], () => jv('int', 7));
  await jvm.loadClass('demo.Main');
  assert.equal(jvm.invoke(jvm.construct('demo.Main', []), 'run').value, 7);
});
