'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadToSupabaseStorage } = require('../server/supabase-storage');

test('Supabase Storage uploads product images using the server-only key', async function () {
  const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET'];
  const previousValues = new Map(names.map(function (name) { return [name, process.env[name]]; }));
  const originalFetch = global.fetch;

  try {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal(await uploadToSupabaseStorage(Buffer.from('image'), { extension: '.png', contentType: 'image/png' }), null);

    process.env.SUPABASE_URL = 'https://example-project.supabase.co';
    await assert.rejects(
      uploadToSupabaseStorage(Buffer.from('image'), { extension: '.png', contentType: 'image/png' }),
      function (error) {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'supabase_storage_not_configured');
        return true;
      }
    );

    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-key';
    process.env.SUPABASE_STORAGE_BUCKET = 'catalog images';
    let request;
    global.fetch = async function (url, options) {
      request = { url, options };
      return { ok: true, status: 200 };
    };
    const url = await uploadToSupabaseStorage(Buffer.from('image'), {
      extension: '.png',
      contentType: 'image/png'
    });
    assert.match(url, /^https:\/\/example-project\.supabase\.co\/storage\/v1\/object\/public\/catalog%20images\/[0-9a-f-]+\.png$/i);
    assert.equal(request.options.headers.apikey, 'server-only-test-key');
    assert.equal(request.options.headers.Authorization, 'Bearer server-only-test-key');
    assert.equal(request.options.headers['Content-Type'], 'image/png');
    assert.equal(request.options.headers['x-upsert'], 'false');
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previousValues.get(name) === undefined) delete process.env[name];
      else process.env[name] = previousValues.get(name);
    }
  }
});

test('Supabase Storage upload failures are returned as explicit service errors', async function () {
  const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET'];
  const previousValues = new Map(names.map(function (name) { return [name, process.env[name]]; }));
  const originalFetch = global.fetch;

  try {
    process.env.SUPABASE_URL = 'https://example-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-key';
    delete process.env.SUPABASE_STORAGE_BUCKET;
    global.fetch = async function () { return { ok: false, status: 403 }; };

    await assert.rejects(
      uploadToSupabaseStorage(Buffer.from('image'), { extension: '.jpg', contentType: 'image/jpeg' }),
      function (error) {
        assert.equal(error.status, 502);
        assert.equal(error.code, 'supabase_storage_upload_failed');
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previousValues.get(name) === undefined) delete process.env[name];
      else process.env[name] = previousValues.get(name);
    }
  }
});
