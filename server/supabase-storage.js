'use strict';

async function uploadToSupabaseStorage(buffer, imageFormat) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl && !serviceRoleKey) return null;
  if (!supabaseUrl || !serviceRoleKey) {
    const error = new Error('Supabase Storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    error.status = 503;
    error.code = 'supabase_storage_not_configured';
    throw error;
  }

  let baseUrl;
  try {
    baseUrl = new URL(supabaseUrl);
  } catch (cause) {
    const error = new Error('SUPABASE_URL must be a valid URL.');
    error.status = 503;
    error.code = 'supabase_storage_not_configured';
    error.cause = cause;
    throw error;
  }
  if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    const error = new Error('SUPABASE_URL must use HTTP or HTTPS and must not contain credentials.');
    error.status = 503;
    error.code = 'supabase_storage_not_configured';
    throw error;
  }

  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'product-images';
  const objectPath = `${require('node:crypto').randomUUID()}${imageFormat.extension}`;
  const uploadUrl = new URL(
    `/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`,
    baseUrl.origin
  );

  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': imageFormat.contentType,
        'Cache-Control': 'max-age=31536000',
        'x-upsert': 'false'
      },
      body: buffer
    });
  } catch (cause) {
    const error = new Error('Could not upload the product image to Supabase Storage.');
    error.status = 502;
    error.code = 'supabase_storage_upload_failed';
    error.cause = cause;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Supabase Storage returned HTTP ${response.status}.`);
    error.status = 502;
    error.code = 'supabase_storage_upload_failed';
    throw error;
  }

  return new URL(
    `/storage/v1/object/public/${encodeURIComponent(bucket)}/${objectPath}`,
    baseUrl.origin
  ).toString();
}

module.exports = { uploadToSupabaseStorage };
