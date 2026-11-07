const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TEST_PORT = 18982;
const ALLOWED_CLASS_MEMBERS_COLS = new Set(['class_code', 'parent_id', 'child_name']);

const mockState = {
  throwErrorOnTable: null,
  failSelectOnTable: null,
  simulate23505OnClassMembersInsert: false,
  stripSocketRemoteAddress: false,
  tables: {
    families: [],
    classes: [],
    class_members: [],
  },
};

function resetState() {
  mockState.throwErrorOnTable = null;
  mockState.failSelectOnTable = null;
  mockState.simulate23505OnClassMembersInsert = false;
  mockState.stripSocketRemoteAddress = false;
  for (const k of Object.keys(mockState.tables)) {
    mockState.tables[k] = [];
  }
}

function validateClassMembersCols(cols) {
  for (const col of cols) {
    const trimmed = col.trim();
    if (!trimmed) continue;
    if (!ALLOWED_CLASS_MEMBERS_COLS.has(trimmed)) {
      return new Error(`column class_members.${trimmed} does not exist`);
    }
  }
  return null;
}

function makeQueryBuilder(table) {
  const filters = [];
  let pendingInsert = false;
  let pendingInsertPayload = null;
  let isSingle = false;
  let isMaybeSingle = false;
  let isSelectOp = false;
  let columnError = null;

  const applyFilters = (rows) => rows.filter((r) => filters.every((fn) => fn(r)));

  const builder = {
    select(colsStr) {
      isSelectOp = true;
      if (table === 'class_members') {
        if (!colsStr || colsStr === '*') {
          columnError = new Error('select must explicitly list existing class_members columns');
        } else {
          const err = validateClassMembersCols(colsStr.split(','));
          if (err) columnError = err;
        }
      }
      return builder;
    },
    insert(payload) {
      pendingInsertPayload = Array.isArray(payload) ? payload : [payload];
      if (table === 'class_members') {
        for (const item of pendingInsertPayload) {
          const err = validateClassMembersCols(Object.keys(item));
          if (err) {
            columnError = err;
            return builder;
          }
        }
      }
      pendingInsert = true;
      return builder;
    },
    eq(col, val) {
      if (table === 'class_members') {
        const err = validateClassMembersCols([col]);
        if (err) columnError = err;
      }
      filters.push((r) => r[col] === val);
      return builder;
    },
    limit() {
      return builder;
    },
    single() {
      isSingle = true;
      return builder;
    },
    maybeSingle() {
      isMaybeSingle = true;
      return builder;
    },
    then(resolve, reject) {
      if (columnError) {
        return Promise.resolve({ data: null, error: columnError }).then(resolve, reject);
      }
      if (mockState.throwErrorOnTable === table) {
        return Promise.resolve({
          data: null,
          error: new Error('SENSITIVE_DB_INTERNAL_DETAIL_DO_NOT_LEAK'),
        }).then(resolve, reject);
      }
      if (isSelectOp && !pendingInsert && mockState.failSelectOnTable === table) {
        return Promise.resolve({
          data: null,
          error: new Error(`simulated select failure on ${table}`),
        }).then(resolve, reject);
      }
      if (pendingInsert) {
        if (table === 'class_members' && mockState.simulate23505OnClassMembersInsert) {
          const dupErr = new Error('duplicate key value violates unique constraint');
          dupErr.code = '23505';
          return Promise.resolve({ data: null, error: dupErr }).then(resolve, reject);
        }
        const inserted = pendingInsertPayload.map((item, idx) => {
          const row =
            table === 'class_members'
              ? {
                  class_code: item.class_code,
                  parent_id: item.parent_id,
                  child_name: item.child_name,
                }
              : { id: `${table}-${Date.now()}-${idx}`, ...item };
          mockState.tables[table].push(row);
          return row;
        });
        const data = isSingle || isMaybeSingle ? inserted[0] || null : inserted;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
      const matched = applyFilters(mockState.tables[table] || []);
      const data = isSingle || isMaybeSingle ? matched[0] || null : matched;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

let serverInstance = null;

before(() => {
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(TEST_PORT);
  process.env.AWS_ACCESS_KEY_ID = 'mock-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'mock-secret';
  process.env.AWS_REGION = 'us-east-1';
  process.env.S3_BUCKET = 'mock-bucket';
  process.env.SUPABASE_URL = 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'mock-twilio-token';
  process.env.TWILIO_WHATSAPP_FROM = '+15005550006';

  const awsPath = require.resolve('aws-sdk');
  require.cache[awsPath] = {
    id: awsPath,
    filename: awsPath,
    loaded: true,
    exports: {
      config: { update() {} },
      S3: function MockS3() {
        return {};
      },
      Rekognition: function MockRekognition() {
        return {};
      },
    },
  };

  const supabasePath = require.resolve('@supabase/supabase-js');
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: {
      createClient() {
        return {
          from(table) {
            return makeQueryBuilder(table);
          },
        };
      },
    },
  };

  const twilioPath = require.resolve('twilio');
  require.cache[twilioPath] = {
    id: twilioPath,
    filename: twilioPath,
    loaded: true,
    exports: Object.assign(
      function mockTwilio() {
        return { messages: { create: async () => ({ sid: 'SM_MOCK' }) } };
      },
      {
        validateRequest: () => true,
        webhook: () => (req, res, next) => next(),
        twiml: {
          MessagingResponse: function MockMessagingResponse() {
            return { message() {}, toString: () => '<Response/>' };
          },
        },
      }
    ),
  };

  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    serverInstance = this;
    this.on('request', (req) => {
      if (mockState.stripSocketRemoteAddress && req.socket) {
        Object.defineProperty(req.socket, 'remoteAddress', {
          value: undefined,
          configurable: true,
        });
      }
    });
    return origListen.apply(this, args);
  };

  const indexPath = require.resolve('../index.js');
  delete require.cache[indexPath];
  require('../index.js');
  http.Server.prototype.listen = origListen;
});

beforeEach(() => {
  resetState();
});

after(() => {
  if (serverInstance) serverInstance.close();
});

function requestJson(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let data = raw;
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('POST /join-class validates classCode against /^\\d{4}$/ and parentId (1..100 chars)', async () => {
  for (const bad of ['', '123', '12345', 'abcd', '12a4', null, 1234]) {
    const res = await requestJson(
      'POST',
      '/join-class',
      { classCode: bad, parentId: 'parent-1' },
      { 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '10.0.0.1' }
    );
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { error: 'invalid_class_code' });
  }

  for (const badParent of [undefined, null, '', 123, {}, 'p'.repeat(101)]) {
    const res = await requestJson(
      'POST',
      '/join-class',
      { classCode: '1234', parentId: badParent },
      { 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '10.0.0.1' }
    );
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { error: 'invalid_parent_id' });
  }
});

test('POST /join-class treats Postgres 23505 unique violation on concurrent class_members insert as 200 {"joined":true}', async () => {
  mockState.tables.classes.push({ class_code: '4321', teacher_name: 'גננת רונית' });
  mockState.simulate23505OnClassMembersInsert = true;

  const res = await requestJson(
    'POST',
    '/join-class',
    { classCode: '4321', parentId: 'parent-23505', childName: 'מאיה' },
    { 'x-real-ip': '10.0.0.99', 'x-forwarded-for': '10.0.0.99' }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { joined: true });
});

test('POST /join-class saves childName (capped at 100 chars) in 3-column class_members and second join creates no second row', async () => {
  mockState.tables.classes.push({ class_code: '4321', teacher_name: 'גננת רונית' });
  const longName = 'מ'.repeat(140);

  const first = await requestJson(
    'POST',
    '/join-class',
    {
      classCode: '4321',
      parentId: 'parent-1',
      childName: longName,
    },
    { 'x-real-ip': '10.0.0.2', 'x-forwarded-for': '10.0.0.2' }
  );
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { joined: true });
  assert.equal(mockState.tables.class_members.length, 1);
  assert.deepEqual(Object.keys(mockState.tables.class_members[0]).sort(), [
    'child_name',
    'class_code',
    'parent_id',
  ]);
  assert.equal(mockState.tables.class_members[0].class_code, '4321');
  assert.equal(mockState.tables.class_members[0].parent_id, 'parent-1');
  assert.equal(mockState.tables.class_members[0].child_name.length, 100);

  // Second join with same classCode and parentId must NOT create a second row
  const second = await requestJson(
    'POST',
    '/join-class',
    {
      classCode: '4321',
      parentId: 'parent-1',
      childName: longName,
    },
    { 'x-real-ip': '10.0.0.2', 'x-forwarded-for': '10.0.0.2' }
  );
  assert.equal(second.status, 200);
  assert.deepEqual(second.data, { joined: true });
  assert.equal(mockState.tables.class_members.length, 1);
});

test('failing existence select on class_members or failing families lookup returns 500 {"error":"server_error"} and inserts nothing', async () => {
  mockState.tables.classes.push({ class_code: '4321', teacher_name: 'גננת רונית' });
  mockState.failSelectOnTable = 'class_members';

  const failMemberSelect = await requestJson(
    'POST',
    '/join-class',
    {
      classCode: '4321',
      parentId: 'parent-err-1',
      childName: 'מאיה',
    },
    { 'x-real-ip': '10.0.0.3', 'x-forwarded-for': '10.0.0.3' }
  );
  assert.equal(failMemberSelect.status, 500);
  assert.deepEqual(failMemberSelect.data, { error: 'server_error' });
  assert.equal(mockState.tables.class_members.length, 0);

  // Failing families lookup (when childName is omitted) also returns 500 and inserts nothing
  mockState.failSelectOnTable = 'families';
  const failFamilySelect = await requestJson(
    'POST',
    '/join-class',
    {
      classCode: '4321',
      parentId: 'parent-err-2',
    },
    { 'x-real-ip': '10.0.0.4', 'x-forwarded-for': '10.0.0.4' }
  );
  assert.equal(failFamilySelect.status, 500);
  assert.deepEqual(failFamilySelect.data, { error: 'server_error' });
  assert.equal(mockState.tables.class_members.length, 0);
});

test('per-parent limit is 5 and per-IP limit is 20 (keyed on X-Real-IP, ignoring forged X-Forwarded-For)', async () => {
  // 1) Per-parent limit: 5 failures for the same parentId across different X-Real-IPs -> 6th is 429
  for (let i = 0; i < 5; i++) {
    const res = await requestJson(
      'POST',
      '/join-class',
      { classCode: '9999', parentId: 'same-parent-5' },
      { 'x-real-ip': `192.0.2.${i + 1}`, 'x-forwarded-for': `192.0.2.${i + 1}` }
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: 'class_not_found' });
  }
  const sixthSameParent = await requestJson(
    'POST',
    '/join-class',
    { classCode: '9999', parentId: 'same-parent-5' },
    { 'x-real-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.99' }
  );
  assert.equal(sixthSameParent.status, 429);
  assert.deepEqual(sixthSameParent.data, { error: 'too_many_attempts' });

  // 2) Per-IP limit: 20 failures from X-Real-IP 203.0.113.10 with rotating parentIds and forged X-Forwarded-For
  for (let i = 0; i < 20; i++) {
    const res = await requestJson(
      'POST',
      '/join-class',
      { classCode: '9998', parentId: `ip-test-parent-${i}` },
      { 'x-real-ip': '203.0.113.10', 'x-forwarded-for': `198.51.100.${i + 1}` }
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: 'class_not_found' });
  }

  // 21st attempt from same X-Real-IP with forged X-Forwarded-For and fresh parentId -> 429
  const twentyFirstSameRealIp = await requestJson(
    'POST',
    '/join-class',
    { classCode: '9998', parentId: 'ip-test-parent-fresh' },
    { 'x-real-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.250' }
  );
  assert.equal(twentyFirstSameRealIp.status, 429);
  assert.deepEqual(twentyFirstSameRealIp.data, { error: 'too_many_attempts' });

  // Different X-Real-IP (203.0.113.11) is not throttled -> 404
  const differentRealIp = await requestJson(
    'POST',
    '/join-class',
    { classCode: '9998', parentId: 'ip-test-parent-other' },
    { 'x-real-ip': '203.0.113.11', 'x-forwarded-for': '198.51.100.250' }
  );
  assert.equal(differentRealIp.status, 404);
  assert.deepEqual(differentRealIp.data, { error: 'class_not_found' });
});

test('when neither x-real-ip nor socket.remoteAddress exists, getClientIp returns null and skips per-IP counter instead of lumping callers', async () => {
  mockState.stripSocketRemoteAddress = true;
  // Send 25 failing requests with no x-real-ip and stripped socket.remoteAddress, using distinct parentIds
  for (let i = 0; i < 25; i++) {
    const res = await requestJson(
      'POST',
      '/join-class',
      { classCode: '7777', parentId: `no-ip-parent-${i}` },
      { 'x-forwarded-for': `172.16.0.${i + 1}` }
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: 'class_not_found' });
  }
});

test('POST /join-class prunes expired entries when failure maps exceed 1000 entries', async () => {
  const realDateNow = Date.now;
  const baseTime = realDateNow();
  try {
    Date.now = () => baseTime;
    for (let i = 0; i < 1005; i++) {
      const ipStr = `10.99.${Math.floor(i / 250)}.${(i % 250) + 1}`;
      const res = await requestJson(
        'POST',
        '/join-class',
        { classCode: '8888', parentId: `bulk-parent-${i}` },
        { 'x-real-ip': ipStr, 'x-forwarded-for': ipStr }
      );
      assert.equal(res.status, 404);
    }

    const sizesBefore = global.__getJoinClassFailureMapSizes();
    assert.ok(sizesBefore.ip > 1000, `expected ip map > 1000, got ${sizesBefore.ip}`);
    assert.ok(sizesBefore.parent > 1000, `expected parent map > 1000, got ${sizesBefore.parent}`);

    Date.now = () => baseTime + 11 * 60 * 1000;
    const afterExpiry = await requestJson(
      'POST',
      '/join-class',
      { classCode: '8888', parentId: 'bulk-parent-0' },
      { 'x-real-ip': '10.99.0.1', 'x-forwarded-for': '10.99.0.1' }
    );
    assert.equal(afterExpiry.status, 404);
    assert.deepEqual(afterExpiry.data, { error: 'class_not_found' });

    const sizesAfter = global.__getJoinClassFailureMapSizes();
    assert.equal(sizesAfter.ip, 1);
    assert.equal(sizesAfter.parent, 1);
  } finally {
    Date.now = realDateNow;
  }
});

test('POST /join-class returns 500 {"error":"server_error"} on unexpected error without leaking err.message', async () => {
  mockState.throwErrorOnTable = 'classes';
  const res = await requestJson(
    'POST',
    '/join-class',
    { classCode: '1234', parentId: 'parent-err', childName: 'מאיה' },
    { 'x-real-ip': '10.0.0.55', 'x-forwarded-for': '10.0.0.55' }
  );
  assert.equal(res.status, 500);
  assert.deepEqual(res.data, { error: 'server_error' });
  assert.equal(JSON.stringify(res.data).includes('SENSITIVE_DB_INTERNAL_DETAIL'), false);
});
