import test from 'node:test';
import assert from 'node:assert/strict';
import { SlrrJvm, jv } from '../src/index.js';

for (const asynchronous of [false, true]) test(`Object-widened strings dispatch to String (${asynchronous ? 'async' : 'sync'})`, async () => {
  const source = `package test; class Tokens {
    Object token() { return "42"; }
    int decode() { return token().intValue(); }
  }`;
  const jvm = new SlrrJvm({ resolveImport: ({ className }) => className === 'test.Tokens' ? { path: 'Tokens.java', source } : null });
  jvm.natives.register('java.lang.String', 'intValue', [], ({ receiver }) => jv('int', Number.parseInt(String(receiver.value), 10)));
  jvm.natives.register('java.lang.String', 'staticMarker', [], () => jv('int', 7));
  await jvm.loadClass('test.Tokens');
  const receiver = asynchronous ? await jvm.constructAsync('test.Tokens', []) : jvm.construct('test.Tokens', []);
  const invoke = (value: ReturnType<typeof jv>, name: string) => asynchronous ? jvm.invokeAsync(value, name) : jvm.invoke(value, name);
  assert.equal((await invoke(receiver, 'decode')).value, 42);
  assert.equal((await invoke(jv('Object', '123'), 'intValue')).value, 123);
  assert.equal((await invoke(jv('class', 'java.lang.String'), 'staticMarker')).value, 7);
});
