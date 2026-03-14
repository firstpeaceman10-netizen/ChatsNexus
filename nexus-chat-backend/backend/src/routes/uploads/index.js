import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../../db/supabase.js';

const FREE_MAX_BYTES  = 10  * 1024 * 1024; // 10MB
const PRO_MAX_BYTES   = 100 * 1024 * 1024; // 100MB

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  'application/pdf',
  'text/plain', 'text/markdown',
  'application/zip',
]);

export default async function uploadRoutes(app) {

  // ─── Upload file ───────────────────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const plan = req.user.plan;
    const maxBytes = plan === 'pro' ? PRO_MAX_BYTES : FREE_MAX_BYTES;

    let file;
    try {
      file = await req.file();
    } catch {
      return reply.code(400).send({ error: 'No file provided' });
    }

    if (!file) return reply.code(400).send({ error: 'No file provided' });

    // Check content type
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      return reply.code(415).send({ error: 'File type not allowed' });
    }

    // Read file buffer
    const chunks = [];
    let totalSize = 0;
    for await (const chunk of file.file) {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        return reply.code(413).send({
          error: 'File too large',
          message: `File exceeds the ${plan === 'pro' ? '100MB' : '10MB'} limit for your plan.`,
          upgrade: plan === 'free',
        });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Generate safe filename
    const ext = file.filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const key = `uploads/${userId}/${uuidv4()}.${ext}`;

    // Upload to Cloudflare R2
    try {
      const url = await uploadToR2(key, buffer, file.mimetype);

      return reply.send({
        url,
        key,
        filename: file.filename,
        size: totalSize,
        type: file.mimetype,
      });
    } catch (err) {
      app.log.error('Upload failed:', err);
      return reply.code(500).send({ error: 'Upload failed' });
    }
  });

  // ─── Upload avatar ─────────────────────────────────────────────────────
  app.post('/avatar', { preHandler: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;

    let file;
    try {
      file = await req.file();
    } catch {
      return reply.code(400).send({ error: 'No file provided' });
    }

    const allowedAvatarTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    if (!allowedAvatarTypes.has(file.mimetype)) {
      return reply.code(415).send({ error: 'Avatar must be an image (JPEG, PNG, GIF, or WebP)' });
    }

    const chunks = [];
    let totalSize = 0;
    for await (const chunk of file.file) {
      totalSize += chunk.length;
      if (totalSize > 8 * 1024 * 1024) {
        return reply.code(413).send({ error: 'Avatar must be under 8MB' });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const ext = file.mimetype.split('/')[1];
    const key = `avatars/${userId}/${uuidv4()}.${ext}`;
    const url = await uploadToR2(key, buffer, file.mimetype);

    await supabase.from('users').update({ avatar_url: url }).eq('id', userId);

    return reply.send({ url });
  });
}

// ─── R2 upload helper ──────────────────────────────────────────────────────
async function uploadToR2(key, buffer, contentType) {
  if (!process.env.R2_ACCOUNT_ID) {
    // Dev fallback: return a mock URL
    return `https://placeholder.chatnexus.com/${key}`;
  }

  // Using the S3-compatible API
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000',
  }));

  return `${process.env.R2_PUBLIC_URL}/${key}`;
}
