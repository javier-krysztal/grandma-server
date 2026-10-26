if (process.env.NODE_ENV !== "production") { require("dotenv").config(); }

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const COLLECTION_ID = 'grandma-app';
const MATCH_CONFIDENCE = 80;
const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const {
  PORT = 3000,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  S3_BUCKET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  PUBLIC_HOST,
  PUBLIC_PROTOCOL = 'https',
  TWILIO_VALIDATE_REQUESTS = 'true',
} = process.env;

AWS.config.update({
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  region: AWS_REGION,
});

const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));

const rateBucket = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (rateBucket.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  recent.push(now);
  rateBucket.set(ip, recent);
  next();
}

app.use(rateLimit);

app.use(
  twilio.webhook({
    authToken: TWILIO_AUTH_TOKEN,
    validate: TWILIO_VALIDATE_REQUESTS !== 'false',
    host: PUBLIC_HOST || undefined,
    protocol: PUBLIC_PROTOCOL,
  })
);

function decodePhoto(photo) {
  if (!photo || typeof photo !== 'string') {
    throw Object.assign(new Error('photo is required'), { status: 400 });
  }
  const cleaned = photo.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
  return Buffer.from(cleaned, 'base64');
}

function rekognitionImageId(parentId) {
  return String(parentId).replace(/[^a-zA-Z0-9_.\-:]+/g, '_').slice(0, 255);
}

function toWhatsApp(phone) {
  const raw = String(phone).replace(/^whatsapp:/i, '').trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  return `whatsapp:${e164}`;
}

function publicS3Url(key) {
  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

function signedS3Url(key) {
  return s3.getSignedUrl('getObject', {
    Bucket: S3_BUCKET,
    Key: key,
    Expires: 60 * 60 * 24 * 7,
  });
}

async function uploadJpeg(key, buffer) {
  await s3
    .putObject({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
    })
    .promise();
  return publicS3Url(key);
}

let collectionReady;
async function ensureCollection() {
  if (!collectionReady) {
    collectionReady = (async () => {
      try {
        await rekognition.describeCollection({ CollectionId: COLLECTION_ID }).promise();
      } catch (err) {
        if (err.code !== 'ResourceNotFoundException') throw err;
        await rekognition.createCollection({ CollectionId: COLLECTION_ID }).promise();
      }
    })();
  }
  return collectionReady;
}

function generateGrandmaCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

async function uniqueGrandmaCode() {
  for (let i = 0; i < 10; i += 1) {
    const grandmaCode = generateGrandmaCode();
    const { data, error } = await supabase
      .from('families')
      .select('grandma_code')
      .eq('grandma_code', grandmaCode)
      .maybeSingle();
    if (error) throw error;
    if (!data) return grandmaCode;
  }
  throw new Error('Could not generate a unique grandma code');
}

app.post('/save-reference', async (req, res) => {
  try {
    const { parentId, photo } = req.body;
    if (!parentId) {
      return res.status(400).json({ error: 'parentId is required' });
    }

    const bytes = decodePhoto(photo);
    await ensureCollection();

    await rekognition
      .indexFaces({
        CollectionId: COLLECTION_ID,
        ExternalImageId: rekognitionImageId(parentId),
        Image: { Bytes: bytes },
        MaxFaces: 1,
        DetectionAttributes: ['DEFAULT'],
      })
      .promise();

    await uploadJpeg(`references/${parentId}.jpg`, bytes);
    return res.json({ success: true });
  } catch (err) {
    console.error('save-reference', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to save reference' });
  }
});

app.post('/check-photo', async (req, res) => {
  try {
    const { parentId, photo } = req.body;
    if (!parentId) {
      return res.status(400).json({ error: 'parentId is required' });
    }

    const bytes = decodePhoto(photo);
    await ensureCollection();

    let search;
    try {
      search = await rekognition
        .searchFacesByImage({
          CollectionId: COLLECTION_ID,
          Image: { Bytes: bytes },
          FaceMatchThreshold: 70,
          MaxFaces: 5,
        })
        .promise();
    } catch (err) {
      if (err.code === 'InvalidParameterException') {
        return res.json({ found: false, photoUrl: null });
      }
      throw err;
    }

    const expectedId = rekognitionImageId(parentId);
    const match = (search.FaceMatches || []).find((m) => {
      const confidence = m.Similarity ?? m.Face?.Confidence ?? 0;
      const externalId = m.Face?.ExternalImageId;
      return confidence >= MATCH_CONFIDENCE && (!externalId || externalId === expectedId);
    });

    if (!match) {
      return res.json({ found: false, photoUrl: null });
    }

    const timestamp = Date.now();
    const key = `matches/${parentId}/${timestamp}.jpg`;
    const photoUrl = await uploadJpeg(key, bytes);
    const mediaUrl = signedS3Url(key);

    const { error: insertError } = await supabase.from('matched_photos').insert({
      parent_id: parentId,
      photo_url: photoUrl,
      matched_at: new Date().toISOString(),
    });
    if (insertError) throw insertError;

    const { data: family, error: familyError } = await supabase
      .from('families')
      .select('grandma_phone, child_name')
      .eq('parent_id', parentId)
      .maybeSingle();
    if (familyError) throw familyError;

    // SMS removed from here - fires once on registration only

    return res.json({ found: true, photoUrl });
  } catch (err) {
    console.error('check-photo', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to check photo' });
  }
});

app.post('/register-family', async (req, res) => {
  try {
    const { parentId, grandmaPhone, childName, childDob } = req.body;
    if (!parentId || !grandmaPhone) {
      return res.status(400).json({ error: 'parentId and grandmaPhone are required' });
    }

    const grandmaCode = await uniqueGrandmaCode();
    const { error } = await supabase.from('families').upsert(
      {
        parent_id: parentId,
        grandma_phone: grandmaPhone,
        child_name: childName,
        child_dob: childDob,
        grandma_code: grandmaCode,
      },
      { onConflict: 'parent_id' }
    );
    if (error) throw error;

    // Send one-time SMS invite to grandma
    if (grandmaPhone) {
      try {
        await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_FROM.replace('whatsapp:', ''),
          to: grandmaPhone,
          body: `${childName || 'Your grandchild'}'s parent is sharing photos with you through קטן! Download the app and enter code ${grandmaCode} to see the photos.`,
        });
      } catch (smsErr) {
        console.log('SMS invite failed (non-fatal):', smsErr.message);
      }
    }

    return res.json({ grandmaCode });
  } catch (err) {
    console.error('register-family', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to register family' });
  }
});


app.get("/parent-feed/:parentId", async (req, res) => {
  try {
    const { parentId } = req.params;
    const { data: photos, error } = await supabase.from("matched_photos").select("id, photo_url, matched_at").eq("parent_id", parentId).order("matched_at", { ascending: false });
    if (error) throw error;
    const feed = (photos || []).map((photo) => {
      const url = photo.photo_url || "";
      const bucketPrefix = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/`;
      const key = url.startsWith(bucketPrefix) ? url.replace(bucketPrefix, "") : url;
      return { ...photo, photo_url: signedS3Url(key) };
    });
    return res.json(feed);
  } catch (err) {
    console.error("parent-feed", err);
    return res.status(500).json({ error: err.message });
  }
});
app.get('/grandma-feed/:grandmaCode', async (req, res) => {
  try {
    const { grandmaCode } = req.params;
    const { data: family, error: familyError } = await supabase
      .from('families')
      .select('parent_id, child_name, child_dob')
      .eq('grandma_code', grandmaCode)
      .maybeSingle();
    if (familyError) throw familyError;
    if (!family) {
      return res.status(404).json({ error: 'Family not found' });
    }

    const { data: photos, error: photosError } = await supabase
      .from('matched_photos')
      .select('id, parent_id, photo_url, matched_at')
      .eq('parent_id', family.parent_id)
      .order('matched_at', { ascending: false });
    if (photosError) throw photosError;

    const feed = (photos || []).map((photo) => {
      const url = photo.photo_url || '';
      const bucketPrefix = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/`;
      const key = url.startsWith(bucketPrefix) ? url.replace(bucketPrefix, '') : url;
      const signedUrl = signedS3Url(key);
      return {
        ...photo,
        photo_url: signedUrl,
        child_name: family.child_name,
        child_dob: family.child_dob,
      };
    });

    return res.json(feed);
  } catch (err) {
    console.error('grandma-feed', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to load feed' });
  }
});

app.post('/grandma-heart', async (req, res) => {
  try {
    const { grandmaCode, photoUrl } = req.body;
    if (!grandmaCode || !photoUrl) {
      return res.status(400).json({ error: 'grandmaCode and photoUrl are required' });
    }

    const { data: family, error } = await supabase
      .from('families')
      .select('parent_id, child_name')
      .eq('grandma_code', grandmaCode)
      .maybeSingle();
    if (error) throw error;
    if (!family) {
      return res.status(404).json({ error: 'Family not found' });
    }

    const parentPhone = family.parent_id;
    const childName = family.child_name || 'Your child';

    console.log("Sending WhatsApp to:", toWhatsApp(family.grandma_phone), "from:", toWhatsApp(TWILIO_WHATSAPP_FROM)); await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM.replace("whatsapp:", ""),
      to: toWhatsApp(parentPhone),
      body: `${childName}'s savta loved a photo ❤️`,
      mediaUrl: [photoUrl],
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('grandma-heart', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to send heart' });
  }
});

// Teacher mode endpoints
app.post('/create-class', async (req, res) => {
  try {
    const { teacherName, classCode } = req.body;
    if (!teacherName || !classCode) {
      return res.status(400).json({ error: 'teacherName and classCode are required' });
    }
    if (classCode.length !== 4) {
      return res.status(400).json({ error: 'classCode must be 4 digits' });
    }

    const { data, error } = await supabase
      .from('classes')
      .insert({ class_code: classCode, teacher_name: teacherName })
      .select()
      .single();
    if (error) throw error;

    return res.json({ success: true, class: data });
  } catch (err) {
    console.error('create-class', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to create class' });
  }
});

app.post('/teacher-upload', async (req, res) => {
  try {
    const { classCode, photo } = req.body;
    if (!classCode || !photo) {
      return res.status(400).json({ error: 'classCode and photo are required' });
    }

    const bytes = decodePhoto(photo);
    await ensureCollection();

    // Get all families in this class
    const { data: classMembers, error: membersError } = await supabase
      .from('class_members')
      .select('parent_id')
      .eq('class_code', classCode);
    if (membersError) throw membersError;

    if (!classMembers || classMembers.length === 0) {
      return res.json({ matches: 0, totalFaces: 0, message: 'No families in this class yet' });
    }

    // Run face recognition
    let search;
    try {
      search = await rekognition
        .searchFacesByImage({
          CollectionId: COLLECTION_ID,
          Image: { Bytes: bytes },
          FaceMatchThreshold: MATCH_CONFIDENCE,
          MaxFaces: 10,
        })
        .promise();
    } catch (err) {
      if (err.code === 'InvalidParameterException') {
        return res.json({ matches: 0, totalFaces: 0 });
      }
      throw err;
    }

    let matches = 0;
    const parentIdsInClass = new Set(classMembers.map(m => m.parent_id));

    for (const faceMatch of search.FaceMatches || []) {
      const externalId = faceMatch.Face?.ExternalImageId;
      if (!externalId) continue;

      // Check if this parent is in the class
      if (parentIdsInClass.has(externalId)) {
        const timestamp = Date.now();
        const key = `teacher-photos/${classCode}/${externalId}/${timestamp}.jpg`;
        const photoUrl = await uploadJpeg(key, bytes);

        const { error: insertError } = await supabase.from('matched_photos').insert({
          parent_id: externalId,
          photo_url: photoUrl,
          class_code: classCode,
          matched_at: new Date().toISOString(),
        });
        if (insertError) throw insertError;

        matches++;
      }
    }

    return res.json({ matches, totalFaces: search.FaceMatches?.length || 0 });
  } catch (err) {
    console.error('teacher-upload', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to process teacher upload' });
  }
});

// Event mode endpoints
app.post('/create-event', async (req, res) => {
  try {
    const { parentId, eventName, classCode } = req.body;
    if (!parentId || !eventName || !classCode) {
      return res.status(400).json({ error: 'parentId, eventName, and classCode are required' });
    }

    // Generate unique 4-digit event code
    let eventCode;
    for (let i = 0; i < 10; i++) {
      const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const { data, error } = await supabase
        .from('events')
        .select('event_code')
        .eq('event_code', code)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        eventCode = code;
        break;
      }
    }
    if (!eventCode) {
      return res.status(500).json({ error: 'Could not generate unique event code' });
    }

    const { data, error } = await supabase
      .from('events')
      .insert({
        event_code: eventCode,
        event_name: eventName,
        class_code: classCode,
        created_by: parentId,
      })
      .select()
      .single();
    if (error) throw error;

    return res.json({ success: true, event: data });
  } catch (err) {
    console.error('create-event', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to create event' });
  }
});

app.post('/event-upload', async (req, res) => {
  try {
    const { eventCode, photo, parentId } = req.body;
    if (!eventCode || !photo || !parentId) {
      return res.status(400).json({ error: 'eventCode, photo, and parentId are required' });
    }

    const bytes = decodePhoto(photo);
    await ensureCollection();

    // Get event details
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('class_code')
      .eq('event_code', eventCode)
      .maybeSingle();
    if (eventError) throw eventError;
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Get all families in the class
    const { data: classMembers, error: membersError } = await supabase
      .from('class_members')
      .select('parent_id')
      .eq('class_code', event.class_code);
    if (membersError) throw membersError;

    // Upload photo to S3
    const timestamp = Date.now();
    const key = `event-photos/${eventCode}/${parentId}/${timestamp}.jpg`;
    const photoUrl = await uploadJpeg(key, bytes);

    // Run face recognition
    let search;
    try {
      search = await rekognition
        .searchFacesByImage({
          CollectionId: COLLECTION_ID,
          Image: { Bytes: bytes },
          FaceMatchThreshold: MATCH_CONFIDENCE,
          MaxFaces: 10,
        })
        .promise();
    } catch (err) {
      if (err.code === 'InvalidParameterException') {
        // No faces found, just upload the photo
        const { error: insertError } = await supabase.from('event_photos').insert({
          event_code: eventCode,
          parent_id: parentId,
          photo_url: photoUrl,
          matched_parent_id: null,
          created_at: new Date().toISOString(),
        });
        if (insertError) throw insertError;
        return res.json({ matches: 0, totalFaces: 0 });
      }
      throw err;
    }

    let matches = 0;
    const parentIdsInClass = new Set(classMembers.map(m => m.parent_id));

    for (const faceMatch of search.FaceMatches || []) {
      const externalId = faceMatch.Face?.ExternalImageId;
      if (!externalId) continue;

      // Check if this parent is in the class
      if (parentIdsInClass.has(externalId)) {
        const { error: insertError } = await supabase.from('event_photos').insert({
          event_code: eventCode,
          parent_id: parentId,
          photo_url: photoUrl,
          matched_parent_id: externalId,
          matched_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });
        if (insertError) throw insertError;

        matches++;
      }
    }

    // If no matches, still add the photo to the event
    if (matches === 0) {
      const { error: insertError } = await supabase.from('event_photos').insert({
        event_code: eventCode,
        parent_id: parentId,
        photo_url: photoUrl,
        matched_parent_id: null,
        created_at: new Date().toISOString(),
      });
      if (insertError) throw insertError;
    }

    return res.json({ matches, totalFaces: search.FaceMatches?.length || 0 });
  } catch (err) {
    console.error('event-upload', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to process event upload' });
  }
});

app.get('/event-feed/:eventCode', async (req, res) => {
  try {
    const { eventCode } = req.params;

    const { data: photos, error } = await supabase
      .from('event_photos')
      .select('id, parent_id, photo_url, matched_parent_id, matched_at, created_at')
      .eq('event_code', eventCode)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const feed = (photos || []).map((photo) => {
      const url = photo.photo_url || '';
      const bucketPrefix = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/`;
      const key = url.startsWith(bucketPrefix) ? url.replace(bucketPrefix, '') : url;
      return {
        ...photo,
        photo_url: signedS3Url(key),
      };
    });

    return res.json(feed);
  } catch (err) {
    console.error('event-feed', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to load event feed' });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected error' });
});

app.listen(PORT, () => {
  console.log(`grandma-server listening on ${PORT}`);
});
