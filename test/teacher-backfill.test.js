const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');

const TEST_PORT = 18986;

const mockState = {
  s3Puts: [],
  s3Copies: [],
  s3Objects: new Map(),
  lifecycleConfigs: [],
  compareFacesCalls: [],
  compareFacesHandler: null,
  detectFacesResult: {
    FaceDetails: [
      { Confidence: 99.5, BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.4, Height: 0.4 } },
    ],
  },
  searchFacesResult: { FaceMatches: [] },
  tables: {
    families: [],
    classes: [],
    class_members: [],
    matched_photos: [],
    children: [],
  },
};

function resetState() {
  mockState.s3Puts = [];
  mockState.s3Copies = [];
  mockState.s3Objects.clear();
  mockState.compareFacesCalls = [];
  mockState.compareFacesHandler = null;
  mockState.searchFacesResult = { FaceMatches: [] };
  for (const k of Object.keys(mockState.tables)) {
    mockState.tables[k] = [];
  }
  if (global.__getTeacherBackfillState) {
    global.__getTeacherBackfillState().clear();
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
let sampleBuffer = null;
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

  sampleBuffer = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 100, g: 120, b: 140 } },
  })
    .jpeg()
    .toBuffer();
  sampleBase64 = sampleBuffer.toString('base64');

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
            mockState.s3Objects.set(params.Key, {
              Key: params.Key,
              Body: params.Body,
              LastModified: new Date(),
            });
            return { promise: async () => ({}) };
          },
          copyObject(params) {
            mockState.s3Copies.push(params);
            return { promise: async () => ({}) };
          },
          getObject(params) {
            const obj = mockState.s3Objects.get(params.Key);
            return {
              promise: async () => ({ Body: (obj && obj.Body) || sampleBuffer }),
            };
          },
          listObjectsV2(params) {
            const prefix = params.Prefix || '';
            const Contents = [...mockState.s3Objects.values()].filter((o) =>
              o.Key.startsWith(prefix)
            );
            return {
              promise: async () => ({ Contents, IsTruncated: false }),
            };
          },
          getBucketLifecycleConfiguration() {
            return { promise: async () => ({ Rules: [] }) };
          },
          putBucketLifecycleConfiguration(params) {
            mockState.lifecycleConfigs.push(params);
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
          indexFaces() {
            return { promise: async () => ({ FaceRecords: [{ Face: { FaceId: 'f1' } }] }) };
          },
          detectFaces() {
            return { promise: async () => mockState.detectFacesResult };
          },
          searchFacesByImage() {
            return { promise: async () => mockState.searchFacesResult };
          },
          compareFaces(params) {
            mockState.compareFacesCalls.push(params);
            return {
              promise: async () => {
                if (mockState.compareFacesHandler) {
                  return mockState.compareFacesHandler(params);
                }
                return { FaceMatches: [{ Similarity: 96.5 }], UnmatchedFaces: [] };
              },
            };
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

test('teacher-upload saves to teacher-pool/ even when class has no families yet, and joining class retroactively backfills matched_photos via S3-to-S3 compareFaces', async () => {
  mockState.tables.classes.push({ class_code: '5151', teacher_name: 'גננת רונית' });

  // 1) Teacher uploads a photo BEFORE any parent has joined class 5151
  const uploadRes = await requestJson('POST', '/teacher-upload', {
    classCode: '5151',
    photo: sampleBase64,
  });
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.data.message, 'No families in this class yet');

  // Verify photo was saved to teacher-pool/5151/<hash>.jpg and 30-day lifecycle rule was configured
  const poolKeys = [...mockState.s3Objects.keys()].filter((k) => k.startsWith('teacher-pool/5151/'));
  assert.equal(poolKeys.length, 1);
  assert.equal(mockState.lifecycleConfigs.length, 1);
  const hash = poolKeys[0].split('/').pop().replace('.jpg', '');

  // 2) Parent joins class 5151 -> background backfill runs compareFaces against references/parent-late.jpg
  const joinRes = await requestJson('POST', '/join-class', {
    classCode: '5151',
    parentId: 'parent-late',
    childName: 'מאיה',
  });
  assert.equal(joinRes.status, 200);
  await global.__waitForTeacherBackfill();

  assert.equal(mockState.compareFacesCalls.length, 1);
  assert.equal(mockState.compareFacesCalls[0].SimilarityThreshold, 90);
  assert.equal(
    mockState.compareFacesCalls[0].SourceImage.S3Object.Name,
    'references/parent-late.jpg'
  );
  assert.equal(mockState.compareFacesCalls[0].TargetImage.S3Object.Name, poolKeys[0]);

  // Verify matched_photos row was inserted with exact same photo_url format as /teacher-upload
  assert.equal(mockState.tables.matched_photos.length, 1);
  assert.equal(mockState.tables.matched_photos[0].parent_id, 'parent-late');
  assert.equal(mockState.tables.matched_photos[0].class_code, '5151');
  assert.equal(
    mockState.tables.matched_photos[0].photo_url,
    `https://mock-bucket.s3.us-east-1.amazonaws.com/teacher-photos/5151/parent-late/${hash}.jpg`
  );

  // 3) Repeat join-class does not re-compare or duplicate matched_photos
  await requestJson('POST', '/join-class', {
    classCode: '5151',
    parentId: 'parent-late',
    childName: 'מאיה',
  });
  await global.__waitForTeacherBackfill();
  assert.equal(mockState.compareFacesCalls.length, 1);
  assert.equal(mockState.tables.matched_photos.length, 1);
});

test('backfill falls back to crop-based findMatchingFaces when compareFaces hits 15-face target limit, and retries if an error occurred before completion', async () => {
  mockState.tables.classes.push({ class_code: '5151', teacher_name: 'גננת רונית' });
  mockState.s3Objects.set('teacher-pool/5151/0123456789abcdef.jpg', {
    Key: 'teacher-pool/5151/0123456789abcdef.jpg',
    Body: sampleBuffer,
    LastModified: new Date(),
  });

  // 1) First attempt throws a transient S3/Rekognition error -> marker must NOT be set to 'done'
  let shouldThrow = true;
  mockState.compareFacesHandler = async () => {
    if (shouldThrow) {
      throw new Error('Transient Rekognition throttling error');
    }
    // Simulate a 15-face group photo where the child wasn't in the top 15 largest faces
    return {
      FaceMatches: [],
      UnmatchedFaces: Array.from({ length: 15 }, () => ({})),
    };
  };
  mockState.searchFacesResult = {
    FaceMatches: [{ Similarity: 95.0, Face: { ExternalImageId: 'parent-group' } }],
  };

  await requestJson('POST', '/join-class', {
    classCode: '5151',
    parentId: 'parent-group',
    childName: 'נועם',
  });
  await global.__waitForTeacherBackfill();
  assert.equal(mockState.tables.matched_photos.length, 0);

  // 2) Retry /join-class after transient error clears -> runs again, hits 15-face fallback to findMatchingFaces, and matches!
  shouldThrow = false;
  await requestJson('POST', '/join-class', {
    classCode: '5151',
    parentId: 'parent-group',
    childName: 'נועם',
  });
  await global.__waitForTeacherBackfill();
  assert.equal(mockState.tables.matched_photos.length, 1);
  assert.equal(
    mockState.tables.matched_photos[0].photo_url,
    'https://mock-bucket.s3.us-east-1.amazonaws.com/teacher-photos/5151/parent-group/0123456789abcdef.jpg'
  );
});
