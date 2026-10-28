import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { resolveTenantId } from '../client/src/services/tenantScope.js';
const dbPath = path.join(os.tmpdir(), `tenant-scope-${process.pid}.json`);
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'tenant-scope-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');
after(async () => { await adapter.close(); fs.rmSync(dbPath, {force:true}); });
test('tenant URL wins over absent or stale selection; normal users keep their tenant', () => {
  const user = {role:'SUPER_ADMIN'};
  for (const selectedTenant of [null, {id:'wrong'}, {id:'super_admin'}]) assert.equal(resolveTenantId({pathname:'/tenant/right/users',user,selectedTenant}), 'right');
  assert.equal(resolveTenantId({pathname:'/super-admin',user,selectedTenant:{id:'right'}}), 'right');
  assert.equal(resolveTenantId({pathname:'/tenant/other/users',user:{role:'ADMIN',tenantId:'own'},selectedTenant:{id:'other'}}),'own');
  assert.equal(resolveTenantId({pathname:'/users',user,selectedTenant:null}),null);
});
test('user list rejects missing/invalid tenant and scopes super-admin and admin', async () => {
  await adapter.init();
  for (const id of ['a','b']) {
    await adapter.insertOne('tenants',{id});
    await adapter.insertOne('users',{id:`admin-${id}`,name:id,role:'ADMIN',tenantId:id});
  }
  await adapter.insertOne('users',{id:'su-scope',role:'SUPER_ADMIN',permissions:['*']});
  const app=express(); app.use('/users',usersRouter);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  try {
    const get=(query,userId='su-scope')=>fetch(`http://127.0.0.1:${server.address().port}/users${query}`,{headers:{authorization:`Bearer ${jwt.sign({userId},JWT_SECRET_VALUE,{expiresIn:60})}`}});
    for (const query of ['', '?tenantId=', '?tenantId=a&tenantId=b']) assert.equal((await get(query)).status,400);
    assert.equal((await get('?tenantId=missing')).status,404);
    const response=await get('?tenantId=a'); assert.equal(response.status,200);
    assert.deepEqual((await response.json()).map(u=>u.id),['admin-a']);
    assert.deepEqual((await (await get('?tenantId=b','admin-a')).json()).map(u=>u.id),['admin-a']);
  } finally { await new Promise(r=>server.close(r)); }
});
