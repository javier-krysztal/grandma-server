const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TEST_PORT = 18987;

const mockState = {
  classInsert23505Remaining: 0,
  eventInsert23505Remaining: 0,
  tables: {
    families: [],
    classes: [],
    class_members: [],
    events: [],
  },
};

function resetState() {
  mockState.classInsert23505Remaining = 0;
  mockState.eventInsert23505Remaining = 0;
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
        if (table === 'classes') {
          const item = pendingInsertPayload[0];
          const exists = mockState.tables.classes.some((c) => c.class_code === item.class_code);
          if (exists || mockState.classInsert23505Remaining > 0) {
            if (mockState.classInsert23505Remaining > 0) {
              mockState.classInsert23505Remaining -= 1;
            }
            const dupErr = new Error(
              'duplicate key value violates unique constraint "classes_pkey"'
            );
            dupErr.code = '23505';
            return Promise.resolve({ data: null, error: dupErr }).then(resolve, reject);
          }
        }
        if (table === 'events') {
          const item = pendingInsertPayload[0];
          const exists = mockState.tables.events.some((e) => e.event_code === item.event_code);
          if (exists || mockState.eventInsert23505Remaining > 0) {
            if (mockState.eventInsert23505Remaining > 0) {
              mockState.eventInsert23505Remaining -= 1;
            }
            const dupErr = new Error(
              'duplicate key value violates unique constraint "events_event_code_key"'
            );
            dupErr.code = '23505';
            return Promise.resolve({ data: null, error: dupErr }).then(resolve, reject);
          }
        }

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

function requestJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
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

test('POST /create-class retries with a new 4-digit code on 23505 collision and returns clear error after 10 collisions', async () => {
  // Pre-insert class '1234' so initial code '1234' hits 23505 and retries with a new code
  mockState.tables.classes.push({ class_code: '1234', teacher_name: 'Existing' });

  const res = await requestJson('POST', '/create-class', {
    teacherName: 'גננת רונית',
    classCode: '1234',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.match(res.data.class.class_code, /^\d{4}$/);
  assert.notEqual(res.data.class.class_code, '1234');
  assert.equal(mockState.tables.classes.length, 2);

  // When all 10 attempts collide with 23505, returns 500 with clear error
  mockState.classInsert23505Remaining = 10;
  const failRes = await requestJson('POST', '/create-class', {
    teacherName: 'גננת רונית',
    classCode: '1234',
  });
  assert.equal(failRes.status, 500);
  assert.deepEqual(failRes.data, {
    error: 'Could not generate a unique class code, please try again',
  });
});

test('POST /create-event retries with a new 4-digit event_code on 23505 insert collision and returns clear error after 10 collisions', async () => {
  mockState.eventInsert23505Remaining = 3;

  const res = await requestJson('POST', '/create-event', {
    parentId: 'parent-1',
    eventName: 'Purim Party',
    classCode: '5151',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.match(res.data.event.event_code, /^\d{4}$/);
  assert.equal(mockState.eventInsert23505Remaining, 0);

  // When all 10 attempts collide with 23505, returns 500 with clear error
  mockState.eventInsert23505Remaining = 10;
  const failRes = await requestJson('POST', '/create-event', {
    parentId: 'parent-2',
    eventName: 'Another Party',
    classCode: '5151',
  });
  assert.equal(failRes.status, 500);
  assert.deepEqual(failRes.data, {
    error: 'Could not generate a unique event code, please try again',
  });
});
