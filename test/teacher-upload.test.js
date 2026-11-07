const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');

const TEST_PORT = 18984;

const mockState = {
  s3Puts: [],
  allowedMatchedPhotosCols: new Set(['id', 'parent_id', 'photo_url', 'class_code', 'matched_at', 'taken_at', 'asset_id', 'event_code']),
  detectFacesResult: {
    FaceDetails: [
      { Confidence: 99.5, BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.5, Height: 0.5 } },
    ],
  },
  searchFacesResult: { FaceMatches: [] },
  tables: {
    class_members: [],
    matched_photos: [],
    children: [],
  },
};

function resetState() {
  mockState.s3Puts = [];
  mockState.allowedMatchedPhotosCols = new Set([
    'id',
    'parent_id',
    'photo_url',
    'class_code',
    'matched_at',
    'taken_at',
    'asset_id',
    'event_code',
  ]);
  mockState.searchFacesResult = { FaceMatches: [] };
  for (const k of Object.keys(mockState.tables)) {
    mockState.tables[k] = [];
  }
}

function makeQueryBuilder(table) {
  const filters = [];
  let pendingInsert = false;
  let pendingInsertPayload = null;
  let columnError = null;

  const applyFilters = (rows) => rows.filter((r) => filters.every((fn) => fn(r)));

  const builder = {
    select(colsStr) {
      if (table === 'matched_photos' && colsStr && colsStr !== '*') {
        for (const col of colsStr.split(',')) {
          const trimmed = col.trim();
          if (trimmed && !mockState.allowedMatchedPhotosCols.has(trimmed)) {
            columnError = new Error(
              `Could not find the '${trimmed}' column of 'matched_photos' in the schema cache`
            );
          }
        }
      }
      return builder;
    },
    insert(payload) {
      pendingInsertPayload = Array.isArray(payload) ? payload : [payload];
      if (table === 'matched_photos') {
        for (const item of pendingInsertPayload) {
          for (const col of Object.keys(item)) {
            if (!mockState.allowedMatchedPhotosCols.has(col)) {
              columnError = new Error(
                `Could not find the '${col}' column of 'matched_photos' in the schema cache`
              );
              return builder;
            }
          }
        }
      }
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
    then(resolve, reject) {
      if (columnError) {
        return Promise.resolve({ data: null, error: columnError }).then(resolve, reject);
      }
      if (pendingInsert) {
        const inserted = pendingInsertPayload.map((item, idx) => {
          const row = { id: `${table}-${Date.now()}-${idx}`, ...item };
          mockState.tables[table].push(row);
          return row;
        });
        return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
      }
      const matched = applyFilters(mockState.tables[table] || []);
      return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
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

test('POST /teacher-upload returns 500 with failed=true and matches=0 when matched_photos rejects unknown column (e.g. missing class_code)', async () => {
  // Remove class_code from allowed columns to simulate a table missing class_code
  mockState.allowedMatchedPhotosCols.delete('class_code');
  mockState.tables.class_members.push({
    class_code: '5151',
    parent_id: 'parent-1',
    child_name: 'מאיה',
  });
  mockState.searchFacesResult = {
    FaceMatches: [{ Similarity: 99.1, Face: { ExternalImageId: 'parent-1' } }],
  };

  const res = await requestJson('POST', '/teacher-upload', {
    classCode: '5151',
    photo: sampleBase64,
  });
  assert.equal(res.status, 500);
  assert.deepEqual(res.data, {
    error: 'server_error',
    failed: true,
    matches: 0,
  });
  assert.equal(mockState.tables.matched_photos.length, 0);
});

test('POST /teacher-upload succeeds and stores class_code when matched_photos has class_code column', async () => {
  mockState.tables.class_members.push({
    class_code: '5151',
    parent_id: 'parent-1',
    child_name: 'מאיה',
  });
  mockState.searchFacesResult = {
    FaceMatches: [{ Similarity: 99.1, Face: { ExternalImageId: 'parent-1' } }],
  };

  const res = await requestJson('POST', '/teacher-upload', {
    classCode: '5151',
    photo: sampleBase64,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    matches: 1,
    totalFaces: 1,
    failed: false,
  });
  assert.equal(mockState.tables.matched_photos.length, 1);
  assert.equal(mockState.tables.matched_photos[0].class_code, '5151');
  assert.equal(mockState.tables.matched_photos[0].parent_id, 'parent-1');
});
