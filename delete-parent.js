// Delete all data for one parent account.
// Usage: node delete-parent.js <parentId>
// Requires .env with AWS creds, S3_BUCKET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
require('dotenv').config();
const AWS = require('aws-sdk');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const parentId = process.argv[2];
if (!parentId) { console.log('Usage: node delete-parent.js <parentId>'); process.exit(1); }

AWS.config.update({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region: process.env.AWS_REGION });
const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = process.env.S3_BUCKET;
const COLLECTION_ID = 'grandma-app';

async function listS3Keys(prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }).promise();
    keys.push(...(res.Contents || []).map((o) => o.Key));
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

async function deleteS3Prefix(prefix) {
  const keys = await listS3Keys(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.deleteObjects({ Bucket: BUCKET, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }).promise();
  }
  return keys.length;
}

async function main() {
  const { data: children } = await supabase.from('children').select('child_id').eq('parent_id', parentId);
  const childIds = (children || []).map((c) => c.child_id);
  const { data: events } = await supabase.from('events').select('event_code').eq('created_by', parentId);
  const eventCodes = (events || []).map((e) => e.event_code);
  const prefixes = [`matches/${parentId}/`, `references/${parentId}.jpg`, ...childIds.map((c) => `references/${c}.jpg`)];
  const { data: teacherKeys } = { data: null };
  const s3Prefixes = [...prefixes];
  // teacher/event photos are nested: teacher-photos/<class>/<parent>/, event-photos/<event>/<parent>/
  const allKeys = await listS3Keys('teacher-photos/');
  const eventKeys = await listS3Keys('event-photos/');
  const nested = [...allKeys, ...eventKeys].filter((k) => k.includes(`/${parentId}/`));
  for (const p of s3Prefixes) nested.push(...await listS3Keys(p));

  console.log('\n=== Will delete for parentId', parentId, '===');
  console.log('- children rows:', childIds.length);
  console.log('- families rows: 1 (if exists)');
  console.log('- matched_photos rows for this parent');
  console.log('- class_members rows for this parent');
  console.log('- event_photos rows (uploader or matched)');
  console.log('- events created by this parent:', eventCodes.length);
  console.log('- S3 objects:', nested.length);
  console.log('- Rekognition faces for:', [parentId, ...childIds].join(', ') || parentId);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('\nType YES to confirm: ', r));
  rl.close();
  if (answer !== 'YES') { console.log('Aborted.'); process.exit(0); }

  // Rekognition faces
  let faceToken, deletedFaces = 0;
  do {
    const res = await rekognition.listFaces({ CollectionId: COLLECTION_ID, NextToken: faceToken }).promise();
    const ids = (res.Faces || []).filter((f) => [parentId, ...childIds].includes(f.ExternalImageId)).map((f) => f.FaceId);
    if (ids.length) { await rekognition.deleteFaces({ CollectionId: COLLECTION_ID, FaceIds: ids }).promise(); deletedFaces += ids.length; }
    faceToken = res.NextToken;
  } while (faceToken);
  console.log('Deleted Rekognition faces:', deletedFaces);

  // S3
  for (const p of s3Prefixes) console.log(`Deleted ${await deleteS3Prefix(p)} objects under ${p}`);
  for (const k of nested) { await s3.deleteObject({ Bucket: BUCKET, Key: k }).promise(); }
  console.log('Deleted nested S3 objects:', nested.length);

  // Supabase
  for (const [table, col] of [['matched_photos', 'parent_id'], ['event_photos', 'parent_id'], ['event_photos', 'matched_parent_id'], ['class_members', 'parent_id']]) {
    const { error } = await supabase.from(table).delete().eq(col, parentId);
    console.log(`Deleted from ${table} (${col}):`, error ? error.message : 'ok');
  }
  for (const code of eventCodes) {
    await supabase.from('events').delete().eq('event_code', code);
  }
  await supabase.from('children').delete().eq('parent_id', parentId);
  await supabase.from('families').delete().eq('parent_id', parentId);
  console.log('\nDone.');
}
main().catch((e) => { console.error(e); process.exit(1); });
