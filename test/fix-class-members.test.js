const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');

const TEST_PORT = 18983;
const ALLOWED_CLASS_MEMBERS_COLS = new Set(['class_code', 'parent_id', 'child_name']);

const mockState = {
  s3Puts: [],
  detectFacesResult: {
    FaceDetails: [
      { Confidence: 99.5, BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.4, Height: 0.4 } },
      { Confidence: 99.2, BoundingBox: { Left: 0.5, Top: 0.1, Width: 0.4, Height: 0.4 } },
    ],
  },
  searchFacesResult: { FaceMatches: [] },
  failSelectOnTable: null,
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
  mockState.s3Puts = [];
  mockState.failSelectOnTable = null;
  mockState.searchFacesResult = { FaceMatches: [] };
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
  let pendingInsert = null;
  let pendingInsertPayload = null;
  let isSingle = false;
  let isMaybeSingle = false;
  let columnError = null;
  let isSelectOp = false;

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
    in(col, vals) {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    or() {
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
      if (columnError) {
        return Promise.resolve({ data: null, error: columnError }).then(resolve, reject);
      }
      if (isSelectOp && !pendingInsert && mockState.failSelectOnTable === table) {
        return Promise.resolve({
          data: null,
          error: new Error(`simulated select failure on ${table}`),
        }).then(resolve, reject);
      }
      if (pendingInsert) {
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
let sampleBase64 = null;

before(async () => {
  process.env.NODE_ENV = 'production';
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
          putObject(params) {
            mockState.s3Puts.push(params);
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
            return { promise: async () => mockState.detectFacesResult };
          },
          searchFacesByImage() {
            return { promise: async () => mockState.searchFacesResult };
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

test('create-event and repeated join-event add only one row to 3-column class_members', async () => {
  mockState.tables.families.push({ parent_id: 'parent-creator', child_name: 'מאיה' });
  mockState.tables.families.push({ parent_id: 'parent-joiner', child_name: 'נועם' });

  const created = await requestJson('POST', '/create-event', {
    parentId: 'parent-creator',
    eventName: 'Purim Party',
    classCode: '4242',
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.success, true);
  const eventCode = created.data.event.event_code;
  assert.equal(mockState.tables.class_members.length, 1);
  assert.deepEqual(mockState.tables.class_members[0], {
    class_code: '4242',
    parent_id: 'parent-creator',
    child_name: 'מאיה',
  });

  // Join the event twice with parent-joiner and once again with parent-creator
  const join1 = await requestJson('POST', '/join-event', {
    eventCode,
    parentId: 'parent-joiner',
  });
  assert.equal(join1.status, 200);

  const join2 = await requestJson('POST', '/join-event', {
    eventCode,
    parentId: 'parent-joiner',
  });
  assert.equal(join2.status, 200);

  const joinCreatorAgain = await requestJson('POST', '/join-event', {
    eventCode,
    parentId: 'parent-creator',
  });
  assert.equal(joinCreatorAgain.status, 200);

  // Must have exactly 2 rows total (1 for creator, 1 for joiner), no duplicates
  assert.equal(mockState.tables.class_members.length, 2);
});

test('failing class_members existence select returns 500 {"error":"server_error"} and inserts nothing', async () => {
  mockState.tables.classes.push({ class_code: '4242', teacher_name: 'Event' });
  mockState.tables.events.push({
    event_code: '1111',
    event_name: 'Party',
    class_code: '4242',
    created_by: 'parent-1',
  });
  mockState.failSelectOnTable = 'class_members';

  const joinRes = await requestJson('POST', '/join-event', {
    eventCode: '1111',
    parentId: 'parent-2',
  });
  assert.equal(joinRes.status, 500);
  assert.deepEqual(joinRes.data, { error: 'server_error' });
  assert.equal(mockState.tables.class_members.length, 0);

  const createRes = await requestJson('POST', '/create-event', {
    parentId: 'parent-2',
    eventName: 'New Event',
    classCode: '4242',
  });
  assert.equal(createRes.status, 500);
  assert.deepEqual(createRes.data, { error: 'server_error' });
  assert.equal(mockState.tables.class_members.length, 0);
});

test('event-upload and teacher-upload deduplicate recipients even when class_members has 9 duplicate rows', async () => {
  mockState.tables.classes.push({ class_code: '4242', teacher_name: 'Event' });
  mockState.tables.events.push({
    event_code: '2222',
    event_name: 'Birthday',
    class_code: '4242',
    created_by: 'parent-a',
  });
  // Insert 9 duplicate rows for (4242, parent-a) in class_members
  for (let i = 0; i < 9; i++) {
    mockState.tables.class_members.push({
      class_code: '4242',
      parent_id: 'parent-a',
      child_name: 'מאיה',
    });
  }
  mockState.searchFacesResult = {
    FaceMatches: [{ Similarity: 99.1, Face: { ExternalImageId: 'parent-a' } }],
  };

  const eventUpload = await requestJson('POST', '/event-upload', {
    eventCode: '2222',
    parentId: 'uploader-parent',
    photo: sampleBase64,
  });
  assert.equal(eventUpload.status, 200);
  assert.equal(eventUpload.data.matches, 1);
  assert.equal(mockState.tables.event_photos.length, 1);
  assert.equal(mockState.tables.matched_photos.length, 1);

  const teacherUpload = await requestJson('POST', '/teacher-upload', {
    classCode: '4242',
    photo: sampleBase64,
  });
  assert.equal(teacherUpload.status, 200);
  assert.equal(teacherUpload.data.matches, 1);
  assert.equal(mockState.tables.matched_photos.length, 2);
});
