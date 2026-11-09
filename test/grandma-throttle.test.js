const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');

const TEST_PORT = 18985;

const mockState = {
  tables: {
    families: [],
    matched_photos: [],
    classes: [],
    class_members: [],
    events: [],
    event_photos: [],
    children: [],
  },
};

function resetState() {
  for (const k of Object.keys(mockState.tables)) {
    mockState.tables[k] = [];
  }
}

function makeQueryBuilder(table) {
  const filters = [];
  let pendingInsert = false;
  let pendingInsertPayload = null;
  let isSingle = false;
  let isMaybeSingle = false;

  const applyFilters = (rows) => rows.filter((r) => filters.every((fn) => fn(r)));

  const builder = {
    select() {
      return builder;
    },
    insert(payload) {
      pendingInsertPayload = Array.isArray(payload) ? payload : [payload];
      pendingInsert = true;
      return builder;
    },
    eq(col, val) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    in(col, vals) {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    order() {
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
      if (pendingInsert) {
        const inserted = pendingInsertPayload.map((item, idx) => {
          const row = { id: `${table}-${Date.now()}-${idx}`, ...item };
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
let sampleBase64 = null;

before(async () => {
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

  const buf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 100, g: 120, b: 140 } },
  })
    .jpeg()
    .toBuffer();
  sampleBase64 = buf.toString('base64');

  const awsPath = require.resolve('aws-sdk');
  require.cache[awsPath] = {
    id: awsPath,
    filename: awsPath,
    loaded: true,
    exports: {
      config: { update() {} },
      S3: function MockS3() {
        return {
          putObject() {
            return { promise: async () => ({}) };
          },
          getSignedUrl(_op, params) {
            return `https://signed.example.com/${params.Key}`;
          },
        };
      },
      Rekognition: function MockRekognition() {
        return {
          describeCollection() {
            return {
              promise: async () => ({
                CollectionARN: 'arn:aws:rekognition:us-east-1:000:collection/grandma-app',
              }),
            };
          },
          createCollection() {
            return { promise: async () => ({}) };
          },
          detectFaces() {
            return { promise: async () => ({ FaceDetails: [] }) };
          },
          searchFacesByImage() {
            return { promise: async () => ({ FaceMatches: [] }) };
          },
        };
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

test('GET /grandma-feed/:grandmaCode throttles after 20 not-found failures per IP, never counts valid polls, and valid code works after 25 failures from other addresses', async () => {
  mockState.tables.families.push({
    parent_id: 'parent-valid',
    child_name: 'מאיה',
    child_dob: '2023-01-01',
    grandma_code: '4812',
    grandma_phone: '+972501234567',
  });
  mockState.tables.matched_photos.push({
    id: 'photo-1',
    parent_id: 'parent-valid',
    photo_url: 'matches/parent-valid/1.jpg',
    matched_at: '2026-10-31T10:00:00.000Z',
    taken_at: '2026-10-31T09:00:00.000Z',
    event_code: null,
  });

  // 1) 25 failed attempts from other IP addresses do NOT block grandma's IP (203.0.113.1)
  for (let i = 0; i < 25; i++) {
    const attackerIp = `198.51.100.${(i % 5) + 1}`;
    const res = await requestJson('GET', `/grandma-feed/99${String(i).padStart(2, '0')}`, null, {
      'x-real-ip': attackerIp,
      'x-forwarded-for': attackerIp,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: 'Family not found' });
  }

  // 2) Polling the valid code 30 times from grandma's IP (203.0.113.1) succeeds every time and is never counted
  for (let i = 0; i < 30; i++) {
    const validRes = await requestJson('GET', '/grandma-feed/4812', null, {
      'x-real-ip': '203.0.113.1',
      'x-forwarded-for': '203.0.113.1',
    });
    assert.equal(validRes.status, 200);
    assert.equal(Array.isArray(validRes.data), true);
    assert.equal(validRes.data.length, 1);
    assert.equal(validRes.data[0].child_name, 'מאיה');
  }

  // 3) 20 failed lookups from IP 203.0.113.77 -> 21st returns 429 {"error":"too_many_attempts"}
  for (let i = 0; i < 20; i++) {
    const res = await requestJson('GET', `/grandma-feed/00${String(i).padStart(2, '0')}`, null, {
      'x-real-ip': '203.0.113.77',
      'x-forwarded-for': '203.0.113.77',
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: 'Family not found' });
  }
  const throttledRes = await requestJson('GET', '/grandma-feed/0099', null, {
    'x-real-ip': '203.0.113.77',
    'x-forwarded-for': '203.0.113.77',
  });
  assert.equal(throttledRes.status, 429);
  assert.deepEqual(throttledRes.data, { error: 'too_many_attempts' });
});

test('POST /grandma-heart, POST /join-event, GET /event-feed/:eventCode, POST /event-upload, and POST /teacher-upload throttle after 20 not-found lookups per IP while valid lookups never count', async () => {
  mockState.tables.families.push({
    parent_id: 'parent-1',
    child_name: 'מאיה',
    grandma_code: '4812',
    grandma_phone: '+972501234567',
  });
  mockState.tables.classes.push({ class_code: '5151', teacher_name: 'גננת' });
  mockState.tables.events.push({
    event_code: '9271',
    event_name: 'Party',
    class_code: '5151',
    created_by: 'parent-1',
  });

  // Valid lookups on each endpoint do not increment failure counter
  const validHeart = await requestJson(
    'POST',
    '/grandma-heart',
    { grandmaCode: '4812', photoUrl: 'https://signed.example.com/1.jpg' },
    { 'x-real-ip': '203.0.113.88', 'x-forwarded-for': '203.0.113.88' }
  );
  assert.equal(validHeart.status, 200);
  assert.deepEqual(validHeart.data, { success: true });

  const validEventFeed = await requestJson('GET', '/event-feed/9271', null, {
    'x-real-ip': '203.0.113.88',
    'x-forwarded-for': '203.0.113.88',
  });
  assert.equal(validEventFeed.status, 200);
  assert.deepEqual(validEventFeed.data, []);

  // Now accumulate 20 not-found lookups across short-code endpoints from 203.0.113.88 (5 each across 4 endpoints = 20)
  for (let i = 0; i < 5; i++) {
    const r1 = await requestJson(
      'POST',
      '/grandma-heart',
      { grandmaCode: '0000', photoUrl: 'https://signed.example.com/1.jpg' },
      { 'x-real-ip': '203.0.113.88', 'x-forwarded-for': '203.0.113.88' }
    );
    assert.equal(r1.status, 404);

    const r2 = await requestJson(
      'POST',
      '/join-event',
      { eventCode: '0000', parentId: 'parent-1' },
      { 'x-real-ip': '203.0.113.88', 'x-forwarded-for': '203.0.113.88' }
    );
    assert.equal(r2.status, 404);

    const r3 = await requestJson('GET', '/event-feed/0000', null, {
      'x-real-ip': '203.0.113.88',
      'x-forwarded-for': '203.0.113.88',
    });
    assert.equal(r3.status, 200);

    const r4 = await requestJson(
      'POST',
      '/event-upload',
      { eventCode: '0000', parentId: 'parent-1', photo: sampleBase64 },
      { 'x-real-ip': '203.0.113.88', 'x-forwarded-for': '203.0.113.88' }
    );
    assert.equal(r4.status, 404);
  }

  // Next lookup from 203.0.113.88 on any short-code endpoint is throttled with 429 {"error":"too_many_attempts"}
  for (const [method, path, body] of [
    ['GET', '/grandma-feed/0000', null],
    ['GET', '/grandma-children/0000', null],
    ['POST', '/grandma-heart', { grandmaCode: '0000', photoUrl: 'https://signed.example.com/1.jpg' }],
    ['POST', '/join-event', { eventCode: '0000', parentId: 'parent-1' }],
    ['GET', '/event-feed/0000', null],
    ['POST', '/event-upload', { eventCode: '0000', parentId: 'parent-1', photo: sampleBase64 }],
    ['POST', '/teacher-upload', { classCode: '0000', photo: sampleBase64 }],
  ]) {
    const blocked = await requestJson(method, path, body, {
      'x-real-ip': '203.0.113.88',
      'x-forwarded-for': '203.0.113.88',
    });
    assert.equal(blocked.status, 429, `expected 429 on ${method} ${path}`);
    assert.deepEqual(blocked.data, { error: 'too_many_attempts' });
  }
});
