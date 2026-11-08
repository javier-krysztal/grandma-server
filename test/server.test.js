const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');

const TEST_PORT = 18981;
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

const mockState = {
  s3Puts: [],
  indexedFaces: [],
  detectFacesResult: { FaceDetails: [] },
  searchFacesResult: { FaceMatches: [] },
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
  mockState.indexedFaces = [];
  mockState.detectFacesResult = {
    FaceDetails: [
      {
        Confidence: 99.5,
        BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.5, Height: 0.5 },
      },
    ],
  };
  mockState.searchFacesResult = { FaceMatches: [] };
  for (const k of Object.keys(mockState.tables)) {
    mockState.tables[k] = [];
  }
}

function makeQueryBuilder(table) {
  const filters = [];
  let pendingInsert = null;
  let pendingUpsert = null;
  let isSingle = false;
  let isMaybeSingle = false;

  const applyFilters = (rows) =>
    rows.filter((r) => filters.every((fn) => fn(r)));

  const builder = {
    select() {
      return builder;
    },
    insert(payload) {
      const items = Array.isArray(payload) ? payload : [payload];
      const inserted = items.map((item, idx) => {
        const row = { id: `${table}-${Date.now()}-${idx}`, ...item };
        mockState.tables[table].push(row);
        return row;
      });
      pendingInsert = inserted;
      return builder;
    },
    upsert(payload) {
      const items = Array.isArray(payload) ? payload : [payload];
      const upserted = items.map((item, idx) => {
        const row = { id: `${table}-${Date.now()}-${idx}`, ...item };
        mockState.tables[table].push(row);
        return row;
      });
      pendingUpsert = upserted;
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
      try {
        if (pendingInsert) {
          const data = isSingle || isMaybeSingle ? pendingInsert[0] || null : pendingInsert;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
        if (pendingUpsert) {
          const data = isSingle || isMaybeSingle ? pendingUpsert[0] || null : pendingUpsert;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
        const matched = applyFilters(mockState.tables[table] || []);
        const data = isSingle || isMaybeSingle ? matched[0] || null : matched;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      } catch (e) {
        return Promise.resolve({ data: null, error: e }).then(resolve, reject);
      }
    },
  };
  return builder;
}

let serverInstance = null;
let sampleBase64;

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
            return { promise: async () => ({ CollectionARN: 'arn:aws:rekognition:us-east-1:000:collection/grandma-app' }) };
          },
          createCollection() {
            return { promise: async () => ({}) };
          },
          indexFaces(params) {
            mockState.indexedFaces.push(params);
            return { promise: async () => ({ FaceRecords: [{ Face: { FaceId: 'face-1' } }] }) };
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
        return {
          messages: {
            create: async () => ({ sid: 'SM_MOCK' }),
          },
        };
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

  const buf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .jpeg()
    .toBuffer();
  sampleBase64 = buf.toString('base64');
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
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  resetState();
});

after(() => {
  if (serverInstance) serverInstance.close();
});

test('exposes x-multi-child=0 header by default when MULTI_CHILD_ENABLED is off', async () => {
  const res = await requestJson('GET', '/children/parent-1');
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-multi-child'], '0');
  assert.deepEqual(res.data, []);
});

test('POST /save-reference indexes face with parentId and uploads reference JPEG to S3', async () => {
  const res = await requestJson('POST', '/save-reference', {
    parentId: 'parent-abc',
    photo: sampleBase64,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(mockState.indexedFaces.length, 1);
  assert.equal(mockState.indexedFaces[0].ExternalImageId, 'parent-abc');
  assert.equal(mockState.s3Puts.length, 1);
  assert.equal(mockState.s3Puts[0].Key, 'references/parent-abc.jpg');
});

test('POST /check-photo returns found=false and does not upload to S3 when no face matches', async () => {
  mockState.searchFacesResult = { FaceMatches: [] };
  const res = await requestJson('POST', '/check-photo', {
    parentId: 'parent-abc',
    photo: sampleBase64,
    assetId: 'asset-1',
    takenAt: '2026-10-31T10:00:00.000Z',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.found, false);
  assert.equal(mockState.s3Puts.length, 0);
  assert.equal(mockState.tables.matched_photos.length, 0);
});

test('POST /check-photo saves match and returns duplicate=true when existing row has matching child_id', async () => {
  mockState.searchFacesResult = {
    FaceMatches: [{ Similarity: 98.2, Face: { ExternalImageId: 'parent-abc' } }],
  };
  const first = await requestJson('POST', '/check-photo', {
    parentId: 'parent-abc',
    photo: sampleBase64,
    assetId: 'asset-dup-1',
    takenAt: '2026-10-31T10:00:00.000Z',
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.found, true);
  assert.equal(mockState.s3Puts.length, 1);
  assert.equal(mockState.tables.matched_photos.length, 1);

  // Simulate child_id=null present on the stored row
  mockState.tables.matched_photos[0].child_id = null;

  const second = await requestJson('POST', '/check-photo', {
    parentId: 'parent-abc',
    photo: sampleBase64,
    assetId: 'asset-dup-1',
    takenAt: '2026-10-31T10:00:00.000Z',
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.found, true);
  assert.equal(second.data.duplicate, true);
  assert.equal(mockState.s3Puts.length, 1);
});

test('POST /create-event is idempotent for same parent + eventName + classCode', async () => {
  const first = await requestJson('POST', '/create-event', {
    parentId: 'parent-1',
    eventName: 'Birthday',
    classCode: '1234',
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.success, true);

  const second = await requestJson('POST', '/create-event', {
    parentId: 'parent-1',
    eventName: 'Birthday',
    classCode: '1234',
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.existing, true);
  assert.equal(second.data.event.event_code, first.data.event.event_code);
});

test('POST /migrate-faces rejects requests without x-admin-secret', async () => {
  const res = await requestJson('POST', '/migrate-faces', {});
  assert.equal(res.status, 403);
});
