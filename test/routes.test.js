const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, normalizeCategoryFilter } = require('../server/api');
const { pool } = require('../server/db');

test('public page aliases, assets, and unauthenticated API guards are reachable', async function () {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(function (resolve) { server.once('listening', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = path.join(__dirname, '..');
  const htmlFiles = fs.readdirSync(root).filter(function (file) {
    return file.endsWith('.html') && file !== 'offline.html';
  });
  const pageFiles = {
    '/products': 'products.html',
    '/products.html': 'products.html',
    '/products/': 'products.html',
    '/index.html': 'index.html',
    '/login.html': 'login.html',
    '/register.html': 'register.html',
    '/forgot-password.html': 'forgot-password.html',
    '/reset-password.html': 'reset-password.html',
    '/auth.html': 'auth-flow.html',
    '/auth-flow.html': 'auth-flow.html',
    '/cart.html': 'cart.html',
    '/checkout.html': 'checkout.html',
    '/product-detail.html': 'product-detail.html',
    '/account.html': 'account.html',
    '/orders.html': 'orders.html',
    '/my-orders.html': 'orders.html',
    '/payment-status.html': 'payment-status.html',
    '/vendor-application.html': 'vendor-application.html',
    '/vendor-dashboard.html': 'vendor-dashboard.html',
    '/vendor-workspace.html': 'vendor-dashboard.html',
    '/vendor-products.html': 'vendor-products.html',
    '/vendor-product-form.html': 'vendor-product-form.html',
    '/vendor-orders.html': 'vendor-orders.html',
    '/order-detail.html': 'order-detail.html',
    '/order-confirmation.html': 'order-confirmation.html',
    '/admin-dashboard.html': 'admin-dashboard.html',
    '/admin.html': 'admin-dashboard.html',
    '/admin-workspace.html': 'admin-dashboard.html',
    '/admin-vendors.html': 'admin-vendors.html',
    '/admin-products.html': 'admin-products.html',
    '/admin-freight.html': 'admin-freight.html',
    '/admin-payments.html': 'admin-payments.html',
    '/admin-audit.html': 'admin-audit.html',
    '/admin-orders.html': 'admin-orders.html',
    '/403.html': '403.html',
    '/help.html': 'help.html',
    '/offline.html': 'offline.html',
    '/not-found.html': 'not-found.html'
  };
  const loginRequired = new Set([
    '/cart.html', '/checkout.html', '/account.html', '/orders.html', '/my-orders.html',
    '/payment-status.html', '/order-detail.html', '/order-confirmation.html',
    '/vendor-application.html', '/vendor-dashboard.html', '/vendor-workspace.html',
    '/vendor-products.html', '/vendor-product-form.html', '/vendor-orders.html', '/admin-dashboard.html', '/admin.html',
    '/admin-workspace.html', '/admin-vendors.html', '/admin-products.html', '/admin-freight.html',
    '/admin-payments.html', '/admin-audit.html', '/admin-orders.html'
  ]);

  try {
    const linkedAssets = new Set();
    for (const file of htmlFiles) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      const stylesheets = Array.from(html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi))
        .map(function (match) { return match[1]; });
      const scripts = Array.from(html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi))
        .map(function (match) { return match[1]; });
      assert.ok(stylesheets.includes('/css/styles.css'), `${file} has shared base CSS`);
      assert.ok(stylesheets.includes('/css/market-theme.css'), `${file} has shared theme CSS`);
      assert.ok(stylesheets.length >= 3, `${file} has page-specific CSS`);
      assert.ok(scripts.includes('/js/marketplace.js'), `${file} has shared/page interaction JavaScript`);
      assert.match(html, /<title>[^<]*KEDOLAKA MARKET[^<]*<\/title>/, `${file} uses the new page branding`);
      assert.doesNotMatch(html, /Kundu/i, `${file} has no old customer-facing brand`);
      assert.match(html, /href="\/assets\/kedolaka-market-icon\.svg"/, `${file} uses the new favicon`);
      assert.match(html, /href="\/site\.webmanifest"/, `${file} uses the KEDOLAKA app manifest`);
      assert.match(html, /src="\/assets\/kedolaka-market-compact\.svg"/, `${file} uses the new header logo`);
      if (file === 'products.html') assert.ok(scripts.includes('/js/pages/products.js'), `${file} has Products page JavaScript`);
      assert.doesNotMatch(html, /<style\b/i, `${file} keeps styling in CSS files`);
      for (const asset of stylesheets.concat(scripts)) {
        assert.ok(asset.startsWith('/'), `${file} uses a root-relative asset URL: ${asset}`);
        const diskPath = path.join(root, decodeURIComponent(new URL(asset, 'http://localhost').pathname).slice(1));
        assert.ok(fs.existsSync(diskPath), `${file} references existing asset ${asset}`);
        if (asset.endsWith('.css')) {
          assert.ok(fs.readFileSync(diskPath, 'utf8').trim().length > 0, `${asset} has styles`);
        }
        linkedAssets.add(asset);
      }
    }

    for (const page of ['/', ...Object.keys(pageFiles)]) {
      const response = await fetch(baseUrl + page, { redirect: 'manual' });
      if (loginRequired.has(page)) {
        assert.equal(response.status, 302, page);
        assert.match(response.headers.get('location'), /^\/login\.html\?returnTo=/, page);
        const loginPage = await fetch(new URL(response.headers.get('location'), baseUrl));
        assert.equal(loginPage.status, 200, `${page} login destination`);
      } else {
        assert.equal(response.status, 200, page);
        assert.match(response.headers.get('content-type'), /text\/html/);
      }
      const refreshed = await fetch(baseUrl + page, { redirect: 'manual' });
      assert.equal(refreshed.status, loginRequired.has(page) ? 302 : 200, `refresh ${page}`);
    }

    for (const [legacyPath, destination] of [
      ['/about', '/products'],
      ['/about.html', '/products'],
      ['/about/', '/products'],
      ['/categories.html', '/products'],
      ['/category-browse.html', '/products'],
      ['/categories.html?category=Produce', '/products?category=Produce'],
      ['/search-results.html?q=market', '/products?q=market'],
      ['/search.html?q=market', '/products?q=market'],
      ['/contact.html', '/help.html']
    ]) {
      const response = await fetch(baseUrl + legacyPath, { redirect: 'manual' });
      assert.equal(response.status, 302, legacyPath);
      assert.equal(response.headers.get('location'), destination, legacyPath);
    }

    for (const asset of new Set([
      '/css/styles.css', '/css/market-theme.css',
      '/css/home.css', '/css/checkout.css', '/css/vendor-products.css',
      '/css/vendor-product-form.css', '/js/marketplace.js',
      '/assets/kedolaka-market-icon.svg', '/assets/kedolaka-market-compact.svg',
      '/assets/kedolaka-market-icon-180.png', '/assets/kedolaka-market-icon-192.png',
      '/assets/kedolaka-market-icon-512.png',
      '/assets/kedolaka-market-compact-light.svg', '/assets/kedolaka-market-logo.svg',
      '/assets/kedolaka-market-logo-light.svg',
      '/site.webmanifest',
      '/sw.js',
      '/js/pages/support-contact.js',
      ...linkedAssets
    ])) {
      const response = await fetch(baseUrl + asset);
      assert.equal(response.status, 200, asset);
      if (asset.endsWith('.svg')) assert.match(await response.text(), /<svg\b/, `${asset} is an SVG image`);
      if (asset.endsWith('.png')) {
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.readUInt32BE(0), 0x89504e47, `${asset} is a PNG image`);
      }
      if (asset === '/site.webmanifest') {
        const manifest = await response.json();
        assert.equal(manifest.name, 'KEDOLAKA MARKET');
        assert.ok(manifest.icons.some(function (icon) { return icon.sizes === '192x192'; }));
        assert.ok(manifest.icons.some(function (icon) { return icon.sizes === '512x512'; }));
        assert.equal(manifest.scope, '/');
        assert.equal(manifest.display, 'standalone');
      }
      if (asset === '/sw.js') {
        assert.match(await response.text(), /startsWith\('\/api\/'\)/);
        assert.equal(response.headers.get('service-worker-allowed'), '/');
      }
    }

    const protectedPage = await fetch(baseUrl + '/api/auth/me');
    assert.equal(protectedPage.status, 401);
    const anonymousSession = await fetch(baseUrl + '/api/auth/session');
    assert.equal(anonymousSession.status, 200);
    assert.equal((await anonymousSession.json()).user, null);
    const productsHtml = fs.readFileSync(path.join(root, 'products.html'), 'utf8');
    for (const target of ['/','/products','/help.html','/cart.html']) {
      assert.ok(productsHtml.includes(`href="${target}"`), `Products links to ${target}`);
    }
    const legacyReset = await fetch(baseUrl + '/auth.html?reset=legacy-token', { redirect: 'manual' });
    assert.equal(legacyReset.status, 302);
    assert.equal(legacyReset.headers.get('location'), '/reset-password.html?reset=legacy-token');
    const sameOriginRequest = await fetch(baseUrl + '/api/auth/logout', {
      method: 'POST',
      headers: { Origin: baseUrl }
    });
    assert.equal(sameOriginRequest.status, 401);
    assert.equal(sameOriginRequest.headers.get('access-control-allow-origin'), baseUrl);
    const vercelOriginRequest = await fetch(baseUrl + '/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://vercel.app' }
    });
    assert.equal(vercelOriginRequest.status, 401);
    assert.equal(vercelOriginRequest.headers.get('access-control-allow-origin'), 'https://vercel.app');
    assert.equal(vercelOriginRequest.headers.get('access-control-allow-credentials'), 'true');
    const rejectedOrigin = await fetch(baseUrl + '/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example' }
    });
    assert.equal(rejectedOrigin.status, 403);
    const invalidProduct = await fetch(baseUrl + '/api/products/1garbage');
    assert.equal(invalidProduct.status, 400);
    const invalidPagination = await fetch(baseUrl + '/api/products?limit=10garbage');
    assert.equal(invalidPagination.status, 400);
    const reversedPriceRange = await fetch(baseUrl + '/api/products?minPrice=25&maxPrice=10');
    assert.equal(reversedPriceRange.status, 400);
    const invalidPricePrecision = await fetch(baseUrl + '/api/products?minPrice=1.234');
    assert.equal(invalidPricePrecision.status, 400);
    const invalidFreightOrigins = await fetch(baseUrl + '/api/freight/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originProvinces: ['NCD', 'Invalid Province'], destinationProvince: 'Morobe', provider: 'PostPNG' })
    });
    assert.equal(invalidFreightOrigins.status, 400);
    const resetUnavailable = await fetch(baseUrl + '/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'account@example.test' })
    });
    assert.equal(resetUnavailable.status, 503);
    assert.equal((await resetUnavailable.json()).code, 'email_unavailable');
    const missingRoute = await fetch(baseUrl + '/not-a-page');
    assert.equal(missingRoute.status, 404);
    assert.match(missingRoute.headers.get('content-type'), /text\/html/);
    const missingApiRoute = await fetch(baseUrl + '/api/not-a-route');
    assert.equal(missingApiRoute.status, 404);
    assert.match(missingApiRoute.headers.get('content-type'), /application\/json/);

    const detailHtml = fs.readFileSync(path.join(__dirname, '..', 'product-detail.html'), 'utf8');
    assert.doesNotMatch(detailHtml, /Fresh Cocoa|Fresh Coconut|Sweet Corn Bundle|Highland Coffee/);
    const homeHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const helpHtml = fs.readFileSync(path.join(__dirname, '..', 'help.html'), 'utf8');
    assert.match(helpHtml, /data-support-contact/);
    assert.match(helpHtml, /\/js\/pages\/support-contact\.js/);
    assert.match(helpHtml, /js\/pages\/support-contact\.js/);
    const editorHtml = fs.readFileSync(path.join(__dirname, '..', 'vendor-product-form.html'), 'utf8');
    assert.doesNotMatch(homeHtml, /<style>/i);
    assert.match(editorHtml, /name="stockQuantity"/);
    assert.match(editorHtml, /name="priceKina"/);
    const cartHtml = fs.readFileSync(path.join(__dirname, '..', 'cart.html'), 'utf8');
    const checkoutHtml = fs.readFileSync(path.join(__dirname, '..', 'checkout.html'), 'utf8');
    const registerHtml = fs.readFileSync(path.join(__dirname, '..', 'register.html'), 'utf8');
    const vendorApplicationHtml = fs.readFileSync(path.join(__dirname, '..', 'vendor-application.html'), 'utf8');
    const vendorDashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'vendor-dashboard.html'), 'utf8');
    const orderDetailHtml = fs.readFileSync(path.join(__dirname, '..', 'order-detail.html'), 'utf8');
    const orderConfirmationHtml = fs.readFileSync(path.join(__dirname, '..', 'order-confirmation.html'), 'utf8');
    assert.doesNotMatch(checkoutHtml, /<style>/i);
    assert.match(cartHtml, /id="cartItems"/);
    assert.match(cartHtml, /id="cartSummaryHeading"/);
    assert.match(cartHtml, /id="cartCheckoutLink"/);
    assert.doesNotMatch(cartHtml, /id="placeOrderButton"/);
    assert.match(checkoutHtml, /id="placeOrderButton"/);
    const productDetailHtml = fs.readFileSync(path.join(__dirname, '..', 'product-detail.html'), 'utf8');
    assert.match(productDetailHtml, /id="detailCondition"/);
    assert.match(productDetailHtml, /id="detailPriceUnit"/);
    const productFormHtml = fs.readFileSync(path.join(__dirname, '..', 'vendor-product-form.html'), 'utf8');
    assert.match(productFormHtml, /name="description"[^>]*minlength="20"[^>]*required/);
    assert.match(productFormHtml, /name="condition"[^>]*required/);
    assert.match(productFormHtml, /name="priceUnit"[^>]*required/);
    assert.match(productFormHtml, /name="deliveryNotes"/);
    assert.match(productFormHtml, /id="deliveryProvinceOptions"/);
    assert.match(productFormHtml, /name="deliveryContacts"/);
    assert.match(productFormHtml, /required for delivery listings in this province/i);
    assert.match(checkoutHtml, /name="carrierMethod" value="Ship"/);
    assert.match(checkoutHtml, /name="carrierMethod" value="AirNiugini"/);
    assert.match(checkoutHtml, /name="shippingPayer" value="buyer"/);
    assert.match(checkoutHtml, /name="shippingPayer" value="vendor"/);
    assert.match(fs.readFileSync(path.join(root, 'offline.html'), 'utf8'), /You're offline/);
    for (const field of ['brand', 'model', 'dimensions', 'materials', 'origin', 'warranty',
      'deliveryAreas', 'dispatchTime', 'deliveryEstimate', 'pickupDetails', 'deliveryRestrictions']) {
      assert.match(productFormHtml, new RegExp(`name="${field}"[^>]*required`));
    }
    assert.match(productDetailHtml, /id="detailAdditionalDetails"/);
    assert.match(checkoutHtml, /Payment options by business/);
    assert.match(registerHtml, /id="registrationVendorSetup"/);
    assert.match(registerHtml, /data-vendor-payment-methods/);
    assert.match(vendorApplicationHtml, /id="applicationPaymentMethods"/);
    assert.match(vendorDashboardHtml, /id="vendorPaymentForm"/);
    assert.match(orderDetailHtml, /id="orderPaymentInstructions"/);
    assert.match(orderConfirmationHtml, /id="checkoutOrders"/);
    assert.doesNotMatch(checkoutHtml, /id="orderHistory"/);
    for (const [file, expectedId] of [
      ['login.html', 'signInForm'],
      ['register.html', 'registerForm'],
      ['forgot-password.html', 'forgotPasswordForm'],
      ['reset-password.html', 'resetPasswordForm'],
      ['vendor-products.html', 'vendorProducts'],
      ['vendor-product-form.html', 'vendorProductForm'],
      ['vendor-orders.html', 'vendorOrders'],
      ['admin-vendors.html', 'adminVendors'],
      ['admin-products.html', 'adminProducts'],
      ['admin-freight.html', 'adminFreightForm'],
      ['admin-audit.html', 'adminActivity']
    ]) {
      assert.match(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), new RegExp(`id="${expectedId}"`), file);
    }
    assert.equal(normalizeCategoryFilter('all'), '');
    assert.equal(normalizeCategoryFilter('ALL'), '');
    assert.equal(normalizeCategoryFilter('Produce'), 'Produce');

    for (const [route, file] of Object.entries(pageFiles)) {
      const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        if (/^(?:https?:|mailto:|tel:|data:)/i.test(target)) continue;
        const link = new URL(target, 'http://localhost' + route);
        const response = await fetch(baseUrl + link.pathname);
        assert.equal(response.status, 200, `${route} -> ${target}`);
        if (link.hash) {
          const targetFile = pageFiles[link.pathname] || link.pathname.slice(1);
          const targetHtml = fs.readFileSync(path.join(__dirname, '..', targetFile), 'utf8');
          assert.match(targetHtml, new RegExp(`id=["']${link.hash.slice(1)}["']`), `${route} -> ${target}`);
        }
      }
    }
  } finally {
    await new Promise(function (resolve, reject) {
      server.close(function (error) { if (error) reject(error); else resolve(); });
    });
    await pool.end();
  }
});
