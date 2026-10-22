'use strict';

require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { URL } = require('node:url');
const { chromium } = require('@playwright/test');
const { isConfiguredDatabaseUrl } = require('./db-config');

test('Marketplace navigation, product discovery, filters, details, redirects, and responsive pages work end to end', {
  skip: !isConfiguredDatabaseUrl(process.env.TEST_DATABASE_URL) && 'Set TEST_DATABASE_URL to an initialized disposable PostgreSQL database.'
}, async function () {
  const databaseName = new URL(process.env.TEST_DATABASE_URL).pathname.replace(/^\/+/, '');
  assert.equal(databaseName, 'kundu_market_test', 'Browser tests only run against the disposable test database.');
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'isolated-browser-tests-only-secret-675';
  process.env.PAYMENT_SANDBOX_ENABLED = 'true';

  const { pool, query, checkSchema } = require('../server/db');
  const schema = await checkSchema();
  assert.ok(schema.ok, `Browser E2E requires the complete test schema: ${schema.missing.join(', ')}`);
  const portProbe = net.createServer();
  await new Promise(function (resolve, reject) {
    portProbe.once('error', reject);
    portProbe.listen(0, '127.0.0.1', resolve);
  });
  const port = portProbe.address().port;
  await new Promise(function (resolve, reject) {
    portProbe.close(function (error) { if (error) reject(error); else resolve(); });
  });
  process.env.PORT = String(port);
  process.env.CORS_ORIGINS = `http://127.0.0.1:${port}`;
  const { app } = require('../server/api');
  const suffix = crypto.randomUUID();
  const email = `browser-${suffix}@example.test`;
  const phone = '+6757' + crypto.randomInt(1000000, 9999999);
  const buyerEmail = `browser-buyer-${suffix}@example.test`;
  const buyerPhone = '+6758' + crypto.randomInt(1000000, 9999999);
  const registeredVendorEmail = `browser-vendor-${suffix}@example.test`;
  const registeredVendorPhone = '+6757' + crypto.randomInt(1000000, 9999999);
  const prefix = `Kedolaka E2E ${suffix.slice(0, 8)}`;
  const category = `E2E Category ${suffix.slice(0, 8)}`;
  let userId;
  let buyerId;
  let vendorId;
  let freightRoute;
  const productIds = [];
  let server;
  let browser;

  try {
    const user = await query(
      `INSERT INTO users (full_name, email, phone_number, home_province, role, password_hash)
       VALUES ('Browser E2E Fixture', $1, $2, 'NCD', 'vendor', 'not-used-for-browser-login')
       RETURNING user_id`,
      [email, phone]
    );
    userId = user.rows[0].user_id;
    const vendor = await query(
      `INSERT INTO vendors (user_id, business_name, province, payment_methods, status)
       VALUES ($1, $2, 'NCD', $3::jsonb, 'active') RETURNING vendor_id`,
      [userId, `E2E Store ${suffix.slice(0, 8)}`, JSON.stringify([
        {
          id: 'bank_transfer',
          name: 'Bank transfer', referencePhone: phone, referenceWhatsapp: phone,
          instructions: 'BSP Bank\nAccount name: Test BSP Account\nAccount number: 123456789\n\nKina Bank\nAccount name: Test Kina Account\nAccount number: 987654321\n\nNote: Use the test vendor bank details.'
        },
        {
          id: 'mobile_wallet',
          name: 'Mobile wallet', referencePhone: phone, referenceWhatsapp: phone,
          instructions: 'Provider: Browser Mobile Wallet\nAccount name: Browser Wallet Account\nWallet number: +67570012345\nNote: Use the browser test wallet note.'
        }
      ])]
    );
    vendorId = vendor.rows[0].vendor_id;
    for (let index = 1; index <= 21; index += 1) {
      const product = await query(
        `INSERT INTO products (vendor_id, product_name, description, category, province, price_kina, stock_quantity, image_url, status)
         VALUES ($1, $2, $3, $4, 'NCD', $5, 5, NULL, 'listed')
         RETURNING product_id`,
        [vendorId, `${prefix} Item ${String(index).padStart(2, '0')}`, 'Isolated browser-test listing.', category, 10 + index]
      );
      productIds.push(product.rows[0].product_id);
    }

    const freightCandidates = await query(
      `SELECT origins.origin, destinations.destination
         FROM unnest(ARRAY['NCD','Morobe','Western Highlands','East New Britain','Eastern Highlands','Madang',
           'Milne Bay','East Sepik','West Sepik','Bougainville','Manus','New Ireland','West New Britain',
           'Central','Gulf','Oro','Western','Southern Highlands','Enga','Hela','Jiwaka','Chimbu']::text[]) origins(origin)
         CROSS JOIN unnest(ARRAY['NCD','Morobe','Western Highlands','East New Britain','Eastern Highlands','Madang',
           'Milne Bay','East Sepik','West Sepik','Bougainville','Manus','New Ireland','West New Britain',
           'Central','Gulf','Oro','Western','Southern Highlands','Enga','Hela','Jiwaka','Chimbu']::text[]) destinations(destination)
        WHERE origins.origin = 'NCD' AND origins.origin <> destinations.destination
          AND NOT EXISTS (
            SELECT 1 FROM freight_rates f
             WHERE f.origin_province = origins.origin
               AND f.destination_province = destinations.destination
               AND f.provider = 'AirNiugini'
          )
        LIMIT 1`
    );
    assert.ok(freightCandidates.rows[0], 'The disposable test database needs an unused NCD-to-province PMV route.');
    freightRoute = freightCandidates.rows[0];
    await query(
      `INSERT INTO freight_rates (origin_province, destination_province, provider, amount_kina, is_estimate, active)
       VALUES ($1, $2, 'AirNiugini', 2.75, TRUE, TRUE)`,
      [freightRoute.origin, freightRoute.destination]
    );
    await query(
      `UPDATE products SET delivery_contacts = $1::jsonb WHERE vendor_id = $2`,
      [JSON.stringify([{
        province: 'NCD', name: 'Browser Test Driver',
        phone: registeredVendorPhone, transport: 'Test PMV',
        route: `${freightRoute.origin} to ${freightRoute.destination}`
      }]), vendorId]
    );

    server = app.listen(port, '127.0.0.1');
    await new Promise(function (resolve, reject) {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const vendorContext = await browser.newContext();
    const vendorPage = await vendorContext.newPage();
    const pwaPage = await browser.newPage();
    await pwaPage.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    await pwaPage.evaluate(function () { return navigator.serviceWorker.ready; });
    await pwaPage.waitForFunction(function () { return Boolean(navigator.serviceWorker.controller); });
    const cachedApiUrl = await pwaPage.evaluate(async function () {
      const names = await caches.keys();
      const requests = await Promise.all(names.map(async function (name) {
        const cache = await caches.open(name);
        return cache.keys();
      }));
      return requests.flat().some(function (request) { return new URL(request.url).pathname.startsWith('/api/'); });
    });
    assert.equal(cachedApiUrl, false, 'The PWA does not cache account or marketplace API responses.');
    await pwaPage.context().setOffline(true);
    await pwaPage.goto(baseUrl + '/products', { waitUntil: 'domcontentloaded' });
    assert.match(await pwaPage.locator('h1').innerText(), /You're offline/);
    await pwaPage.context().setOffline(false);
    await pwaPage.close();
    const registration = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Browser Checkout Buyer',
        email: buyerEmail,
        phoneNumber: buyerPhone,
        password: 'BrowserCheckoutPassword-675!',
        role: 'buyer',
        homeProvince: 'NCD'
      })
    });
    assert.equal(registration.status, 201, 'Checkout buyer account is created in the test database.');
    buyerId = (await registration.json()).user.id;
    const sessionCookie = registration.headers.get('set-cookie').split(';')[0];
    const cookieSeparator = sessionCookie.indexOf('=');
    await context.addCookies([{
      name: sessionCookie.slice(0, cookieSeparator),
      value: sessionCookie.slice(cookieSeparator + 1),
      url: baseUrl
    }]);
    const pageErrors = [];
    const failedRequests = [];
    const failedResponses = [];
    const expectedFailureResponses = new Set();
    const vendorPageErrors = [];
    page.on('pageerror', function (error) { pageErrors.push(error.message); });
    vendorPage.on('pageerror', function (error) { vendorPageErrors.push(error.message); });
    page.on('requestfailed', function (request) {
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure() && request.failure().errorText}`);
    });
    vendorPage.on('requestfailed', function (request) {
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure() && request.failure().errorText}`);
    });
    page.on('response', function (response) {
      if (response.status() >= 400 && !expectedFailureResponses.has(response.url())) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    vendorPage.on('response', function (response) {
      if (response.status() >= 400 && !expectedFailureResponses.has(response.url())) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await vendorPage.goto(`${baseUrl}/register.html?role=vendor`, { waitUntil: 'networkidle' });
    const serviceWorkerScope = await vendorPage.evaluate(async function () {
      const registration = await navigator.serviceWorker.ready;
      return registration.scope;
    });
    assert.equal(serviceWorkerScope, baseUrl + '/', 'The installable web app controls the site root.');
    assert.ok(await vendorPage.locator('.main-nav button').filter({ hasText: 'Install app' }).count());
    const registrationBreadcrumb = vendorPage.locator('main nav[aria-label="Breadcrumb"]');
    await registrationBreadcrumb.locator('[aria-current="page"]').waitFor();
    assert.equal(await registrationBreadcrumb.locator('a').first().getAttribute('href'), '/');
    assert.equal(await registrationBreadcrumb.locator('[aria-current="page"]').innerText(), 'Register');
    assert.deepEqual(await registrationBreadcrumb.locator('.breadcrumb-list > li').allInnerTexts(), ['Home', 'Register']);
    await vendorPage.locator('#fullName').fill('Browser Vendor Applicant');
    await vendorPage.locator('#registerEmail').fill(registeredVendorEmail);
    await vendorPage.locator('#registerPhone').fill(registeredVendorPhone);
    await vendorPage.locator('#registerPassword').fill('BrowserVendorPassword-675!');
    await vendorPage.locator('#confirmPassword').fill('BrowserVendorPassword-675!');
    await vendorPage.locator('#registrationNext').click();
    await vendorPage.locator('#registrationStepTwoHeading').waitFor({ state: 'visible' });
    assert.equal(await vendorPage.locator('[data-registration-step="1"]').isVisible(), false);
    assert.equal(await vendorPage.locator('[data-registration-step="2"]').isVisible(), true);
    await vendorPage.locator('#registrationBack').click();
    assert.equal(await vendorPage.locator('#fullName').inputValue(), 'Browser Vendor Applicant', 'Back retains registration details.');
    await vendorPage.locator('#registrationNext').click();
    await vendorPage.locator('#registerRole').selectOption('vendor');
    await vendorPage.locator('#registrationVendorSetup').waitFor({ state: 'visible' });
    await vendorPage.locator('#registerProvince').selectOption('NCD');
    await vendorPage.locator('#registerBusinessName').fill(`Browser Shop ${suffix.slice(0, 8)}`);
    await vendorPage.locator('#registerBusinessProvince').selectOption('NCD');
    await vendorPage.locator('#registrationPaymentMethods input[value="bank_transfer"]').check();
    await vendorPage.locator('#registrationPaymentMethods [name="bank-bsp-account-name"]').fill('Browser BSP Account');
    await vendorPage.locator('#registrationPaymentMethods [name="bank-bsp-account-number"]').fill('111222333');
    await vendorPage.locator('#registrationPaymentMethods [name="bank-kina-account-name"]').fill('Browser Kina Account');
    await vendorPage.locator('#registrationPaymentMethods [name="bank-kina-account-number"]').fill('444555666');
    await vendorPage.locator('#registrationPaymentMethods [name="bank-transfer-note"]').fill('Use the browser test vendor transfer details.');
    await vendorPage.locator('#registrationPaymentMethods [name="reference-phone-bank_transfer"]').fill(registeredVendorPhone);
    await vendorPage.locator('#registrationPaymentMethods [name="reference-whatsapp-bank_transfer"]').fill(registeredVendorPhone);
    await vendorPage.locator('#registrationPaymentMethods input[value="mobile_wallet"]').check();
    await vendorPage.locator('#registrationPaymentMethods [name="mobile-wallet-provider"]').fill('Browser Mobile Wallet');
    await vendorPage.locator('#registrationPaymentMethods [name="mobile-wallet-account-name"]').fill('Browser Wallet Account');
    await vendorPage.locator('#registrationPaymentMethods [name="mobile-wallet-number"]').fill('+67570012345');
    await vendorPage.locator('#registrationPaymentMethods [name="mobile-wallet-note"]').fill('Use the browser test wallet note.');
    await vendorPage.locator('#registrationPaymentMethods [name="reference-phone-mobile_wallet"]').fill(registeredVendorPhone);
    await vendorPage.locator('#registrationPaymentMethods [name="reference-whatsapp-mobile_wallet"]').fill(registeredVendorPhone);
    await vendorPage.setViewportSize({ width: 390, height: 844 });
    const vendorPaymentLayout = await vendorPage.evaluate(function () {
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        fields: Array.from(document.querySelectorAll('#registrationPaymentMethods .vendor-bank-account input, #registrationPaymentMethods .vendor-mobile-wallet input, #registrationPaymentMethods .vendor-reference-contact-fields input'))
          .map(function (input) { return input.getBoundingClientRect(); })
          .every(function (rect) { return rect.left >= 0 && rect.right <= document.documentElement.clientWidth; })
      };
    });
    assert.equal(vendorPaymentLayout.pageWidth, vendorPaymentLayout.viewportWidth, 'Vendor payment setup has no horizontal overflow on mobile.');
    assert.equal(vendorPaymentLayout.fields, true, 'Bank and mobile-wallet fields fit the mobile viewport.');
    await vendorPage.setViewportSize({ width: 1280, height: 900 });
    await vendorPage.locator('#registerForm button[type="submit"]').click();
    await vendorPage.waitForURL(/\/vendor-application\.html$/);
    await vendorPage.waitForFunction(function () {
      const message = document.getElementById('vendorMessage');
      return message && message.textContent.includes('Vendor application status: review');
    });
    const logoutResponse = await vendorPage.evaluate(async function () {
      return (await fetch('/api/auth/logout', { method: 'POST' })).ok;
    });
    assert.equal(logoutResponse, true, 'The registered vendor can sign out before testing login.');
    await vendorPage.goto(baseUrl + '/login.html', { waitUntil: 'networkidle' });
    await vendorPage.locator('#signInEmail').fill(registeredVendorEmail);
    await vendorPage.locator('#signInPassword').fill('BrowserVendorPassword-675!');
    await vendorPage.locator('#signInForm button[type="submit"]').click();
    await vendorPage.waitForURL(/\/vendor-application\.html$/);
    await vendorPage.waitForFunction(function () {
      const message = document.getElementById('vendorMessage');
      return message && message.textContent.includes('Vendor application status: review');
    });
    await vendorPage.goto(baseUrl + '/vendor-dashboard.html', { waitUntil: 'networkidle' });
    assert.equal(await vendorPage.locator('body > header').evaluate(function (header) {
      return getComputedStyle(header).backgroundColor;
    }), 'rgb(255, 255, 255)', 'Vendor workspace uses the same white marketplace header.');
    const vendorNavigation = vendorPage.locator('header .main-nav');
    for (const href of ['/vendor-dashboard.html', '/vendor-products.html', '/vendor-orders.html', '/products', '/help.html']) {
      assert.ok(await vendorNavigation.locator(`a[href="${href}"]`).count() >= 1, `Vendor navigation includes ${href}`);
    }
    await vendorPage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await vendorPage.evaluate(function () {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    }), false, 'The vendor dashboard stays within a mobile viewport.');
    await vendorPage.setViewportSize({ width: 1280, height: 900 });
    await vendorPage.locator('#dashboardPaymentMethods [name="bank-bsp-account-name"]').fill('Updated BSP Account');
    await vendorPage.locator('#dashboardPaymentMethods [name="bank-bsp-account-number"]').fill('999888777');
    await vendorPage.locator('#dashboardPaymentMethods [name="bank-kina-account-name"]').fill('Updated Kina Account');
    await vendorPage.locator('#dashboardPaymentMethods [name="bank-kina-account-number"]').fill('666555444');
    await vendorPage.locator('#dashboardPaymentMethods [name="bank-transfer-note"]').fill('Updated browser test bank note.');
    await vendorPage.locator('#dashboardPaymentMethods [name="reference-phone-bank_transfer"]').fill(registeredVendorPhone);
    await vendorPage.locator('#dashboardPaymentMethods [name="mobile-wallet-provider"]').fill('Updated Mobile Wallet');
    await vendorPage.locator('#dashboardPaymentMethods [name="mobile-wallet-account-name"]').fill('Updated Wallet Account');
    await vendorPage.locator('#dashboardPaymentMethods [name="mobile-wallet-number"]').fill('+67571112222');
    await vendorPage.locator('#dashboardPaymentMethods [name="mobile-wallet-note"]').fill('Updated browser test wallet note.');
    await vendorPage.locator('#dashboardPaymentMethods [name="reference-whatsapp-mobile_wallet"]').fill(registeredVendorPhone);
    await vendorPage.locator('#vendorPaymentForm button[type="submit"]').click();
    await vendorPage.waitForFunction(function () {
      const message = document.getElementById('vendorPaymentStatus');
      return message && message.textContent.includes('Vendor payment methods updated.');
    });
    const savedVendorMethods = await vendorPage.evaluate(async function () {
      const response = await fetch('/api/vendor/dashboard');
      const payload = await response.json();
      return payload.vendor.payment_methods;
    });
    assert.deepEqual(savedVendorMethods.map(function (method) { return method.id; }), ['bank_transfer', 'mobile_wallet']);
    assert.match(savedVendorMethods[0].instructions, /BSP Bank\nAccount name: Updated BSP Account\nAccount number: 999888777/);
    assert.match(savedVendorMethods[0].instructions, /Kina Bank\nAccount name: Updated Kina Account\nAccount number: 666555444/);
    assert.match(savedVendorMethods[0].instructions, /Note: Updated browser test bank note\./);
    assert.match(savedVendorMethods[1].instructions, /Provider: Updated Mobile Wallet\nAccount name: Updated Wallet Account\nWallet number: \+67571112222\nNote: Updated browser test wallet note\./);
    assert.equal(savedVendorMethods[0].referencePhone, registeredVendorPhone);
    assert.equal(savedVendorMethods[1].referenceWhatsapp, registeredVendorPhone);
    assert.deepEqual(vendorPageErrors, [], 'Vendor registration and payment settings produce no browser exceptions.');

    await vendorPage.goto(baseUrl + '/products', { waitUntil: 'networkidle' });
    const publicVendorLinks = await vendorPage.locator('header .main-nav a').evaluateAll(function (links) {
      return links.map(function (link) { return link.getAttribute('href'); });
    });
    assert.ok(publicVendorLinks.includes('/vendor-dashboard.html'), 'Signed-in vendors keep vendor navigation on public pages.');
    assert.ok(publicVendorLinks.includes('/vendor-orders.html'));
    assert.ok(!publicVendorLinks.includes('/account.html'), 'Vendor navigation does not offer buyer account links.');
    assert.equal(await vendorPage.locator('#authToggle').innerText(), 'Sign Out');
    await vendorPage.locator('#authToggle').click();
    await vendorPage.waitForURL('**/index.html');
    await vendorPage.locator('.main-nav a[href="/account.html"]').waitFor();
    assert.ok(await vendorPage.locator('.main-nav a[href="/account.html"]').count(), 'Signing out returns to buyer navigation.');
    assert.equal(await vendorPage.locator('.main-nav a[href="/vendor-dashboard.html"]').count(), 0);

    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('heading', { name: 'Find something good. Shop local.' }).count(), 1);
    const homeProductCard = page.locator('#productGrid .product-card').first();
    await homeProductCard.waitFor();
    assert.equal(await homeProductCard.getByRole('button', { name: /add to cart/i }).count(), 0,
      'Homepage product previews lead to details before the customer adds an item.');
    assert.equal(await homeProductCard.getByRole('link', { name: 'View full details' }).count(), 1);
    assert.equal(await page.locator('#homeSearchSubmit').getAttribute('href'), '/products');
    await page.locator('#keywordSearch').fill('local basket');
    await page.locator('#categoryFilter').selectOption({ index: 1 });
    assert.match(await page.locator('#homeSearchSubmit').getAttribute('href'), /\/products\?q=local\+basket&category=/);
    await page.locator('#sessionProvinceSelect').selectOption('Madang');
    await page.waitForFunction(function () {
      return document.querySelector('[data-deliver-to]')?.textContent === 'Madang';
    });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(function () {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      }), false, `Marketplace home has no horizontal overflow at ${width}px`);
    }

    for (const [route, destination] of [
      ['/about', '**/products'],
      ['/categories.html', '**/products'],
      ['/search-results.html?q=market', '**/products?q=market'],
      ['/contact.html', '**/help.html']
    ]) {
      await page.goto(baseUrl + route, { waitUntil: 'networkidle' });
      await page.waitForURL(destination);
      assert.match(await page.title(), /KEDOLAKA MARKET/);
    }
    for (const route of ['/help.html', '/login.html', '/register.html']) {
      await page.goto(baseUrl + route, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('body > header').evaluate(function (header) {
        return getComputedStyle(header).backgroundColor;
      }), 'rgb(255, 255, 255)', `${route} uses the shared white marketplace header.`);
      assert.equal(await page.locator('body > footer').evaluate(function (footer) {
        return getComputedStyle(footer).backgroundColor;
      }), 'rgb(23, 43, 77)', `${route} uses the shared navy footer.`);
      assert.equal(await page.locator('header .global-market-search').count(), 1, `${route} includes the shared marketplace search.`);
    }
    await page.goto(baseUrl + '/login.html', { waitUntil: 'networkidle' });
    const signInCard = await page.locator('#signInForm').evaluate(function (form) {
      const style = getComputedStyle(form);
      return { background: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow };
    });
    assert.deepEqual(signInCard, {
      background: 'rgb(255, 255, 255)',
      borderRadius: '11px',
      boxShadow: 'rgba(26, 46, 77, 0.05) 0px 4px 16px 0px'
    }, 'Sign-in forms use the shared professional card treatment.');
    await page.goto(baseUrl + '/help.html', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Contact support' }).waitFor();
    assert.doesNotMatch(await page.locator('[data-support-contact]').innerText(), /supportContact|support-contact\.js/i);
    assert.equal(await page.locator('[data-support-contact-details]').isVisible(), true, 'Configured support contact details are shown.');
    assert.equal(await page.getByRole('contentinfo').getByText('KEDOLAKA MARKET').count(), 1);
    const primaryNavigation = page.locator('header .main-nav');
    for (const href of ['/', '/products', '/cart.html', '/orders.html', '/account.html', '/help.html']) {
      assert.ok(await primaryNavigation.locator(`a[href="${href}"]`).count() >= 1, `Shared navigation includes ${href}`);
    }
    for (const retired of ['/about', '/categories.html', '/contact.html', '/search-results.html']) {
      assert.equal(await primaryNavigation.locator(`a[href="${retired}"]`).count(), 0, `Shared navigation omits retired destination ${retired}`);
    }
    await page.getByRole('search', { name: 'Search the marketplace' }).getByRole('searchbox').fill('local basket');
    await page.getByRole('search', { name: 'Search the marketplace' }).getByRole('button', { name: 'Search' }).click();
    await page.waitForURL('**/products?q=local+basket');
    await page.getByRole('link', { name: 'Shop', exact: true }).click();
    await page.waitForURL('**/products');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('[data-deliver-to]').first().innerText(), 'Madang', 'The selected destination remains visible on the products page.');
    const productHeaderLink = page.locator('header .main-nav .nav-links > a[href="/products"]');
    await productHeaderLink.hover();
    assert.deepEqual(await productHeaderLink.evaluate(function (link) {
      const style = getComputedStyle(link);
      return { color: style.color, background: style.backgroundColor };
    }), { color: 'rgb(36, 87, 166)', background: 'rgb(237, 244, 253)' }, 'Hovered links in the white marketplace header remain visible.');
    await page.locator('#productsGrid .market-product-card').first().waitFor();
    const actualCatalog = await page.evaluate(async function () {
      const response = await fetch('/api/products?q=' + encodeURIComponent(document.querySelector('#productsSearch').value || 'Kedolaka E2E'));
      return { status: response.status, body: await response.json() };
    });
    assert.equal(actualCatalog.status, 200);
    assert.ok(Array.isArray(actualCatalog.body.products));

    const productName = `${prefix} Item 01`;
    const exactSearch = new URLSearchParams({
      q: productName, category, minPrice: '11', maxPrice: '11', sort: 'price_asc'
    });
    await page.goto(`${baseUrl}/products?${exactSearch.toString()}`, { waitUntil: 'networkidle' });
    const card = page.locator('.market-product-card').filter({ hasText: productName });
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    const cardPositionBeforeHover = await card.boundingBox();
    await card.hover();
    const cardPositionAfterHover = await card.boundingBox();
    assert.equal(cardPositionAfterHover.x, cardPositionBeforeHover.x, 'Hover styling does not move the product card out from under the pointer.');
    assert.equal(cardPositionAfterHover.y, cardPositionBeforeHover.y, 'Hover styling does not shift the product card vertically.');
    assert.equal(await page.locator('.market-product-card').count(), 1, 'Combined search/category filters narrow actual API results');
    assert.match(await card.innerText(), /K 11(?:\.00)?/);
    assert.match(await card.innerText(), /In stock/);
    assert.match(await card.innerText(), new RegExp(category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(await card.locator('.market-product-vendor').innerText(), /E2E Store/);
    assert.equal(await card.locator('.market-product-delivery').innerText(), 'Delivery or pickup');
    assert.equal(await card.getByRole('link', { name: 'View full details' }).count(), 1);
    assert.doesNotMatch(await card.innerText(), /Isolated browser-test listing/,
      'Search results show a concise preview instead of the full product description.');
    assert.equal(await page.locator('#productsMinPrice').inputValue(), '11');
    assert.equal(await page.locator('#productsMaxPrice').inputValue(), '11');
    assert.equal(await page.locator('#productsSort').inputValue(), 'price_asc');
    assert.match(await card.innerText(), /Image not provided/);
    const filterOptionValues = await page.locator('#productsCategory option').evaluateAll(function (options) {
      return options.map(function (option) { return option.value; });
    });
    assert.ok(filterOptionValues.includes(category), 'Category selector is populated from the real categories endpoint');

    await page.goto(baseUrl + '/products', { waitUntil: 'networkidle' });
    const categorySummary = page.locator('.category-navigation > summary');
    await categorySummary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.category-navigation').evaluate(function (element) { return element.open; }), true);
    const categoryLink = page.locator('.category-navigation-options a').filter({ hasText: category });
    await categoryLink.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/products\?category=/);
    assert.equal(await page.locator('.market-product-card').count(), 20);
    assert.equal(await page.locator('#productsNext').isEnabled(), true);
    await page.locator('#productsNext').click();
    await page.waitForURL(/offset=20/);
    assert.equal(await page.locator('.market-product-card').count(), 1);
    await page.locator('#productsPrevious').click();
    await page.waitForURL(/\/products\?category=/);
    assert.equal(await page.locator('.market-product-card').count(), 20);

    await page.goto(`${baseUrl}/products?${new URLSearchParams({ q: `${productName} no-match` })}`, { waitUntil: 'networkidle' });
    assert.match(await page.locator('#productsFeedback').innerText(), /No product listings match/);
    assert.equal(await page.locator('.market-product-card').count(), 0);

    await query(
      `UPDATE products
          SET description = $1, delivery_notes = $2, additional_details = $3::jsonb
        WHERE product_id = $4`,
      [
        'Full product description with detailed materials, dimensions, and included items.',
        'Keep the item dry and arrange collection after contacting the seller.',
        JSON.stringify({
          brand: 'Browser Test Brand', model: 'BROWSER-001', dimensions: '20 cm x 10 cm',
          materials: 'Locally sourced materials', origin: 'Madang', warranty: 'No warranty',
          deliveryAreas: 'Madang and surrounding districts', dispatchTime: 'Within 2 days',
          deliveryEstimate: '2 to 4 days', pickupDetails: 'Pickup in town by arrangement',
          deliveryRestrictions: 'No restrictions'
        }),
        productIds[0]
      ]
    );
    await page.goto(`${baseUrl}/products?${new URLSearchParams({ q: productName })}`, { waitUntil: 'networkidle' });
    const summaryCard = page.locator('.market-product-card').filter({ hasText: productName });
    await summaryCard.waitFor();
    assert.doesNotMatch(await summaryCard.innerText(), /Full product description|Browser Test Brand|Keep the item dry/,
      'The catalog keeps extended listing information off the product preview.');
    await page.locator('.market-product-card a[href^="/product-detail.html?id="] h3').click();
    await page.waitForURL(/\/product-detail\.html\?id=\d+/);
    await page.waitForFunction(function (name) {
      const title = document.getElementById('detailName');
      return title && title.textContent === name;
    }, productName);
    assert.equal(await page.locator('#detailName').innerText(), productName);
    assert.match(await page.locator('#detailPrice').innerText(), /K 11(?:\.00)?/);
    assert.match(await page.locator('#detailStock').innerText(), /5 available/);
    assert.equal(await page.locator('#detailDelivery').innerText(), 'Delivery or pickup');
    assert.equal(await page.locator('#detailCondition').innerText(), 'New');
    assert.equal(await page.locator('#detailPriceUnit').innerText(), 'item');
    assert.equal(await page.locator('#detailDescription').innerText(),
      'Full product description with detailed materials, dimensions, and included items.');
    assert.equal(await page.locator('#detailDeliveryNotes').innerText(),
      'Keep the item dry and arrange collection after contacting the seller.');
    assert.match(await page.locator('#detailAdditionalDetails').innerText(), /Browser Test Brand/);
    assert.match(await page.locator('#detailAdditionalDetails').innerText(), /20 cm x 10 cm/);
    assert.equal(await page.locator('#addToCartBtn').isEnabled(), true,
      'The customer can add the product after reviewing its full details.');
    assert.equal(await page.locator('#detailImage img').count(), 0, 'No image is invented when the database image_url is empty');
    await query("UPDATE products SET delivery_type = 'delivery' WHERE product_id = $1", [productIds[0]]);

    let failOnce = true;
    await page.route('**/api/products?*', async function (route) {
      if (failOnce) {
        failOnce = false;
        expectedFailureResponses.add(route.request().url());
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: 'Simulated catalog outage.' })
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/products?${new URLSearchParams({ q: productName })}`, { waitUntil: 'networkidle' });
    assert.match(await page.locator('#productsFeedback').innerText(), /could not be loaded/i);
    assert.equal(await page.locator('.market-product-card').count(), 0, 'An API error never renders fallback or fabricated products');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.market-product-card').filter({ hasText: productName }).waitFor();
    await page.unroute('**/api/products?*');

    await page.route('**/api/products?*', async function (route) {
      const url = new URL(route.request().url());
      if (url.searchParams.get('q') === 'browser-missing-fields') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true, status: 200, message: 'Test-only missing-field response.',
            products: [{ product_id: 999999999, product_name: 'Test-only missing-field listing' }],
            total: 1, limit: 20, offset: 0, sort: 'newest'
          })
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/products?q=browser-missing-fields`, { waitUntil: 'networkidle' });
    const missingFieldsCard = page.locator('.market-product-card');
    await missingFieldsCard.waitFor();
    assert.equal(await missingFieldsCard.locator('.market-product-price, .market-product-stock, .market-product-category').count(), 0);
    assert.match(await missingFieldsCard.innerText(), /Image not provided/);
    await page.unroute('**/api/products?*');

    const cssUrls = await page.locator('link[rel="stylesheet"]').evaluateAll(function (links) {
      return links.map(function (link) { return link.href; });
    });
    assert.ok(cssUrls.some(function (url) { return url.endsWith('/css/pages/products.css'); }));
    await page.goto(baseUrl + '/help.html', { waitUntil: 'networkidle' });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(function () {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      assert.equal(overflow, false, `About page has no horizontal overflow at ${width}px`);
    }
    await page.goto(baseUrl + '/products', { waitUntil: 'networkidle' });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(function () {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      assert.equal(overflow, false, `Products page has no horizontal overflow at ${width}px`);
    }
    await page.locator('.category-navigation > summary').click();
    await page.locator('.category-navigation-options a').filter({ hasText: category }).click();
    await page.waitForURL(/\/products\?category=/);
    assert.equal(await page.locator('.market-product-card').count(), 20, 'Mouse selection applies the category filter');

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(baseUrl + '/products', { waitUntil: 'networkidle' });
    await mobilePage.locator('.category-navigation > summary').tap();
    assert.equal(await mobilePage.locator('.category-navigation').evaluate(function (element) { return element.open; }), true);
    await mobilePage.locator('.category-navigation-options a').filter({ hasText: category }).tap();
    await mobilePage.waitForURL(/\/products\?category=/);
    assert.equal(await mobilePage.locator('.market-product-card').count(), 20, 'Touch selection applies the category filter');
    await mobileContext.close();

    const cartResponse = await fetch(`${baseUrl}/api/cart/items/${productIds[0]}`, {
      method: 'POST',
      headers: { Cookie: sessionCookie }
    });
    assert.equal(cartResponse.status, 200);
    await page.goto(baseUrl + '/cart.html', { waitUntil: 'networkidle' });
    await page.locator('#cartItems .cart-item').first().waitFor();
    assert.equal(await page.locator('#cartCheckoutLink').getAttribute('aria-disabled'), 'false');
    assert.equal(await page.locator('#subtotalValue').innerText(), 'K 11.00');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(function () {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    }), false, 'The item list and order summary fit mobile screens.');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#cartCheckoutLink').click();
    await page.waitForURL('**/checkout.html');
    const placeOrder = page.locator('#placeOrderButton');
    await placeOrder.waitFor({ state: 'visible' });
    const checkoutItem = page.locator('#cartItems .cart-item').filter({ hasText: productName });
    await checkoutItem.waitFor();
    assert.match(await checkoutItem.innerText(), /Condition[\s\S]*New/);
    assert.match(await checkoutItem.innerText(), /Price applies to[\s\S]*item/);
    assert.match(await checkoutItem.innerText(), /Areas or provinces served[\s\S]*Madang and surrounding districts/);
    assert.match(await checkoutItem.innerText(), /Preparation or dispatch time[\s\S]*Within 2 days/);
    assert.match(await checkoutItem.innerText(), /Estimated delivery time[\s\S]*2 to 4 days/);
    assert.match(await checkoutItem.innerText(), /Pickup location and arrangements[\s\S]*Pickup in town by arrangement/);
    assert.match(await checkoutItem.innerText(), /Delivery restrictions[\s\S]*No restrictions/);
    assert.match(await checkoutItem.innerText(), /Delivery or pickup notes[\s\S]*Keep the item dry/);
    assert.doesNotMatch(await checkoutItem.innerText(), /Browser Test Driver|\+675\d{8}/,
      'Local driver contact details are not shown for an inter-province destination.');
    const selectedPaymentBeforeProvinceChange = await page.locator('#paymentMethods input[type="radio"]:checked').first().inputValue();
    assert.equal(await placeOrder.isDisabled(), true, 'Checkout remains blocked until all delivery details and a configured route are set.');
    assert.equal(await page.locator('#deliveryProvince').inputValue(), 'Madang', 'The saved Deliver to province preselects the checkout destination.');
    await page.locator('#deliveryProvince').selectOption('NCD');
    await page.waitForFunction(function () {
      const item = document.querySelector('#cartItems .cart-item');
      return item && item.textContent.includes('Browser Test Driver');
    });
    assert.match(await checkoutItem.innerText(), /Driver or skipper[\s\S]*Browser Test Driver/);
    assert.match(await checkoutItem.innerText(), /Phone or WhatsApp[\s\S]*\+675/);
    assert.match(await checkoutItem.innerText(), /Vehicle, boat, or transport provider[\s\S]*Test PMV/);
    assert.match(await checkoutItem.innerText(), /Route and pickup\/drop-off point[\s\S]*NCD to/);
    assert.equal(await page.locator('#paymentMethods input[type="radio"]:checked').first().inputValue(), selectedPaymentBeforeProvinceChange,
      'Changing delivery province preserves the selected payment method.');
    await page.locator('#deliveryProvince').selectOption('Madang');
    await page.waitForFunction(function () {
      const item = document.querySelector('#cartItems .cart-item');
      return item && !item.textContent.includes('Browser Test Driver');
    });
    assert.match(await page.locator('.section-block').first().innerText(), /shared with the seller/i);
    assert.equal(await page.locator('input[name="carrierMethod"][value="Pickup"]').isDisabled(), true);
    assert.equal(await page.locator('input[name="carrierMethod"][value="PMV"]').isDisabled(), true);
    assert.equal(await page.locator('input[name="carrierMethod"][value="AirNiugini"]').isDisabled(), false);
    await page.locator('#deliveryAddress').fill('Test Street, Port Moresby');
    await page.locator('#deliveryProvince').selectOption(freightRoute.destination);
    await page.locator('input[name="carrierMethod"][value="AirNiugini"]').check();
    await page.locator('input[name="shippingPayer"][value="buyer"]').check();
    await page.locator('#deliveryPhone').fill(buyerPhone);
    await page.waitForFunction(function () {
      const status = document.getElementById('freightQuoteStatus');
      return status && (status.textContent.includes('rechecked') ||
        (!status.textContent.startsWith('Select ') && !status.textContent.includes('Checking')));
    });
    assert.match(await page.locator('#freightQuoteStatus').innerText(), /will be rechecked/, 'The selected configured route provides an actual server freight quote.');
    assert.equal(await placeOrder.isEnabled(), true, 'Complete valid delivery details, a quoted route, and payment options enable checkout.');
    const bankTransferDetails = page.locator('#paymentMethods .option-card').filter({ hasText: 'Bank transfer' });
    assert.match(await bankTransferDetails.innerText(), /BSP Bank[\s\S]*Test BSP Account[\s\S]*123456789[\s\S]*Kina Bank[\s\S]*Test Kina Account[\s\S]*987654321[\s\S]*Use the test vendor bank details/);
    assert.equal(await placeOrder.isEnabled(), true, 'Configured cart, route, and vendor payment method enable checkout.');
    assert.equal(await page.locator('#paymentMethods input[type="radio"]').count(), 2, 'Checkout lists every payment method configured by the vendor.');
    assert.match(await bankTransferDetails.innerText(), /WhatsApp \+675/);
    await page.locator('#paymentMethods input[type="radio"][value="mobile_wallet"]').check();
    let checkoutRequest;
    let createdStatus;
    let createdPayload;
    page.on('request', function (request) {
      if (new URL(request.url()).pathname === '/api/checkout') {
        checkoutRequest = {
          idempotencyKey: request.headers()['idempotency-key'],
          body: request.postData()
        };
      }
    });
    await page.route('**/api/checkout', async function (route) {
      const response = await route.fetch();
      createdStatus = response.status();
      createdPayload = await response.json();
      await route.fulfill({ response, body: JSON.stringify(createdPayload) });
    });
    const createdOrderResponse = page.waitForResponse(function (response) {
      return new URL(response.url()).pathname === '/api/checkout' && response.request().method() === 'POST';
    });
    await placeOrder.click();
    const createdResponse = await createdOrderResponse;
    assert.equal(createdStatus, 201, 'Checkout creates an order from the actual cart and freight data: ' + JSON.stringify(createdPayload));
    assert.equal(createdResponse.status(), 201);
    const createdOrder = createdPayload.orders[0];
    assert.equal(createdPayload.paymentMode, 'manual');
    assert.equal(createdPayload.paymentStatus, 'pending', 'Vendor-managed manual orders remain pending until that vendor confirms receipt.');
    assert.equal(Number(createdOrder.subtotal_kina), 11);
    assert.equal(Number(createdOrder.shipping_kina), 2.75);
    assert.equal(Number(createdOrder.total_kina), 13.75, 'Server-calculated order total ignores browser summary values.');
    assert.equal(createdOrder.payment_reference_phone, phone);
    assert.equal(createdOrder.payment_reference_whatsapp, phone);
    assert.ok(checkoutRequest && checkoutRequest.idempotencyKey);
    await page.waitForURL(/\/order-confirmation\.html\?ids=\d+/);
    await page.getByRole('heading', { name: `Order #${createdOrder.order_id}` }).waitFor();
    assert.match(await page.locator('#checkoutOrders').innerText(), /Payment status: pending/i);
    assert.equal(createdOrder.payment_method, 'mobile_wallet');
    assert.match(createdOrder.payment_instructions, /Provider: Browser Mobile Wallet\nAccount name: Browser Wallet Account\nWallet number: \+67570012345\nNote: Use the browser test wallet note\./);
    assert.match(await page.locator('#checkoutOrders').innerText(), /Browser Mobile Wallet[\s\S]*Browser Wallet Account[\s\S]*\+67570012345[\s\S]*browser test wallet note/i);
    assert.match(await page.locator('#checkoutOrders').innerText(), /Send your payment reference to the vendor/);
    assert.equal(await page.locator('#checkoutOrders a[href^="https://wa.me/"]').count(), 1);

    const duplicate = await page.evaluate(async function (request) {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
        body: request.body
      });
      return { status: response.status, body: await response.json() };
    }, checkoutRequest);
    assert.equal(duplicate.status, 200, 'Retrying a checkout with the same idempotency key returns its original order.');
    assert.equal(String(duplicate.body.orders[0].order_id), String(createdOrder.order_id));
    const orderCount = await query('SELECT COUNT(*)::integer AS count FROM orders WHERE buyer_id = $1', [buyerId]);
    assert.equal(orderCount.rows[0].count, 1, 'An idempotent retry cannot create a duplicate order.');
    await page.unroute('**/api/checkout');

    await page.goto(`${baseUrl}/payment-status.html?id=${encodeURIComponent(createdOrder.order_id)}`, { waitUntil: 'networkidle' });
    assert.match(await page.locator('#paymentPageStatus').innerText(), /Pending — payment has not been confirmed/);

    const secondCart = await fetch(`${baseUrl}/api/cart/items/${productIds[0]}`, {
      method: 'POST',
      headers: { Cookie: sessionCookie }
    });
    assert.equal(secondCart.status, 200);
    await page.route('**/api/checkout', async function (route) {
      expectedFailureResponses.add(route.request().url());
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, message: 'Simulated checkout service outage.' })
      });
    });
    await page.goto(baseUrl + '/checkout.html', { waitUntil: 'networkidle' });
    await page.locator('#deliveryAddress').fill('Test Street, Port Moresby');
    await page.locator('#deliveryProvince').selectOption(freightRoute.destination);
    await page.locator('input[name="carrierMethod"][value="AirNiugini"]').check();
    await page.locator('input[name="shippingPayer"][value="buyer"]').check();
    await page.locator('#deliveryPhone').fill(buyerPhone);
    await page.waitForFunction(function () {
      const status = document.getElementById('freightQuoteStatus');
      return status && (status.textContent.includes('rechecked') ||
        (!status.textContent.startsWith('Select ') && !status.textContent.includes('Checking')));
    });
    assert.match(await page.locator('#freightQuoteStatus').innerText(), /will be rechecked/, 'The retry checkout uses the configured server freight rate.');
    await page.locator('#placeOrderButton').click();
    await page.waitForFunction(function () {
      const tracker = document.getElementById('orderTracker');
      return tracker && tracker.textContent.includes('Simulated checkout service outage.');
    });
    assert.equal(await page.locator('#placeOrderButton').isEnabled(), true, 'Checkout unlocks after a failed request so the customer can retry.');
    assert.match(page.url(), /\/checkout\.html$/, 'A failed checkout does not navigate to an order-confirmation page.');
    const orderCountAfterFailure = await query('SELECT COUNT(*)::integer AS count FROM orders WHERE buyer_id = $1', [buyerId]);
    assert.equal(orderCountAfterFailure.rows[0].count, 1, 'A failed checkout response does not create an additional order.');
    await page.unroute('**/api/checkout');

    assert.deepEqual(pageErrors, [], 'No uncaught browser JavaScript exceptions');
    assert.deepEqual(vendorPageErrors, [], 'Vendor settings pages have no uncaught browser JavaScript exceptions');
    assert.deepEqual(failedRequests, [], 'No browser network requests failed');
    assert.deepEqual(failedResponses, [], 'No unexpected HTTP failures during the real-data journey');
    await vendorContext.close();
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server) {
      await new Promise(function (resolve, reject) {
        server.close(function (error) { if (error) reject(error); else resolve(); });
      });
    }
    if (buyerId) {
      await query('DELETE FROM cart_items WHERE user_id = $1', [buyerId]);
      await query('DELETE FROM payments WHERE order_id IN (SELECT order_id FROM orders WHERE buyer_id = $1)', [buyerId]);
      await query('DELETE FROM orders WHERE buyer_id = $1', [buyerId]);
      await query('DELETE FROM users WHERE user_id = $1', [buyerId]);
    }
    await query('DELETE FROM users WHERE email = $1', [registeredVendorEmail]);
    if (freightRoute) {
      await query(
        `DELETE FROM freight_rates
          WHERE origin_province = $1 AND destination_province = $2 AND provider = 'AirNiugini' AND amount_kina = 2.75`,
        [freightRoute.origin, freightRoute.destination]
      );
    }
    if (productIds.length) await query('DELETE FROM products WHERE product_id = ANY($1::bigint[])', [productIds]);
    if (vendorId) await query('DELETE FROM vendors WHERE vendor_id = $1', [vendorId]);
    if (userId) await query('DELETE FROM users WHERE user_id = $1', [userId]);
    await pool.end();
  }
});
