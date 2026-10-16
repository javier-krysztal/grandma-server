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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected error' });
});

app.listen(PORT, () => {
  console.log(`grandma-server listening on ${PORT}`);
});
