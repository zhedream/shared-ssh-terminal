import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Agents } from '../src/agents.js';

test('Agent authentication binds a private secret to a unique instance, not its displayed name or project', () => {
  const agents = new Agents();
  const identity = { id: randomUUID(), name: 'Codex', application: 'Codex', project: 'same-project', task: 'one' };
  agents.register({ identity, secret: 'a'.repeat(64) });
  assert.equal(agents.authenticate(identity.id, 'a'.repeat(64)).id, identity.id);
  assert.throws(() => agents.authenticate(identity.id, 'b'.repeat(64)), /认证失败/);
  assert.throws(() => agents.register({ identity, secret: 'b'.repeat(64) }), /已被使用/);
  const other = { ...identity, id: randomUUID() };
  agents.register({ identity: other, secret: 'b'.repeat(64) });
  assert.notEqual(agents.authenticate(other.id, 'b'.repeat(64)).id, identity.id);
});
