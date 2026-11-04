import assert from 'node:assert/strict';
import test from 'node:test';
import { SlrrJvm, jv } from '../src/index';

test('native deferred work waits for caller completion and explicit nested yields', async () => {
  const source = `package demo; class Worker {
    int value; int observed;
    native void arm(); native void io(); native void pause();
    void launch() { arm(); io(); value = 7; }
    void nestedPause() { pause(); }
    void launchAndYield() { value = 9; arm(); nestedPause(); }
  }`;
  const jvm = new SlrrJvm({ resolveImport: () => ({ path: 'Worker.java', source }) });
  jvm.natives.register('demo.Worker', 'arm', [], ({receiver, continuation}) => {
    assert.ok(continuation);
    void continuation.ready.then(() => jvm.set(receiver, 'observed', jvm.get(receiver, 'value')));
    return jv('void', undefined);
  });
  jvm.natives.registerAsync('demo.Worker', 'io', [], async () => {
    await new Promise(resolve => setTimeout(resolve, 30)); return jv('void', undefined);
  });
  jvm.natives.registerAsync('demo.Worker', 'pause', [], async ({receiver, continuation}) => {
    continuation?.yield();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(jvm.get(receiver, 'observed').value, 9, 'nested yield releases parent scheduled work');
    return jv('void', undefined);
  });
  await jvm.loadClass('demo.Worker');
  const worker = await jvm.constructAsync('demo.Worker', []);
  await jvm.invokeAsync(worker, 'launch');
  await Promise.resolve();
  assert.equal(jvm.get(worker, 'observed').value, 7, 'ordinary async I/O does not release deferred work');
  await jvm.invokeAsync(worker, 'launchAndYield');
});
