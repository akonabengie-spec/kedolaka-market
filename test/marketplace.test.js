const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { isConfiguredDatabaseUrl } = require('./db-config');
require('dotenv').config();

test('payment configuration stays disabled by default and rejects incomplete production settings', async function () {
  const { GATEWAY_ADAPTERS, getPaymentConfiguration } = require('../server/payments');
  assert.deepEqual(getPaymentConfiguration({ NODE_ENV: 'production' }).methods, []);
  assert.throws(function () {
    getPaymentConfiguration({ NODE_ENV: 'production', PAYMENT_SANDBOX_ENABLED: 'true' });
  }, /cannot be true in production/);
  assert.throws(function () {
    getPaymentConfiguration({ PAYMENT_CASH_ON_DELIVERY_ENABLED: 'true' });
  }, /PAYMENT_CASH_ON_DELIVERY_INSTRUCTIONS/);
  assert.throws(function () {
    getPaymentConfiguration({ PAYMENT_BSP_PAY_ENABLED: 'true' });
  }, /NOT CONFIGURED/);
  assert.equal(GATEWAY_ADAPTERS.bsp_pay.status, 'NOT CONFIGURED');
  assert.equal(GATEWAY_ADAPTERS.kina_bank_ipg.status, 'NOT CONFIGURED');
  assert.equal(GATEWAY_ADAPTERS.digicel_financial_services.status, 'NOT CONFIGURED');
  assert.equal(GATEWAY_ADAPTERS.digitec_png_financial_services.status, 'NOT CONFIGURED');
  assert.equal(GATEWAY_ADAPTERS.omega_paymybills.status, 'NOT CONFIGURED');
  await assert.rejects(GATEWAY_ADAPTERS.bsp_pay.createPayment(), /NOT CONFIGURED/);
});

test('database marketplace flow covers catalog, vendor approval, freight, checkout, and admin audit', {
  skip: !isConfiguredDatabaseUrl(process.env.TEST_DATABASE_URL) && 'Set TEST_DATABASE_URL to an initialized disposable PostgreSQL database.'
}, async function () {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const databaseName = new URL(databaseUrl).pathname.replace(/^\/+/, '');
  assert.equal(databaseName, 'kundu_market_test', 'Refusing to run fixtures outside the designated disposable test database.');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = 'integration-test-secret-only-not-for-production-675';
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_SANDBOX_ENABLED = 'true';
  process.env.PAYMENT_RESERVATION_MINUTES = '30';
  process.env.PAYMENT_MANUAL_RESERVATION_MINUTES = '1440';
  process.env.PAYMENT_MANUAL_BANK_TRANSFER_ENABLED = 'true';
  process.env.PAYMENT_MANUAL_BANK_TRANSFER_INSTRUCTIONS = 'Use the merchant transfer details provided outside this test.';
  process.env.PAYMENT_CASH_ON_DELIVERY_ENABLED = 'true';
  process.env.PAYMENT_CASH_ON_DELIVERY_INSTRUCTIONS = 'Cash is collected in person by the authorized delivery representative.';
  process.env.PAYMENT_IN_PERSON_ENABLED = 'true';
  process.env.PAYMENT_IN_PERSON_INSTRUCTIONS = 'Arrange payment directly with the authorized marketplace operator.';

  const { app } = require('../server/api');
  const { query, pool } = require('../server/db');
  const suffix = crypto.randomUUID();
  const adminEmail = `admin-${suffix}@example.test`;
  const vendorEmail = `vendor-${suffix}@example.test`;
  const secondVendorEmail = `second-vendor-${suffix}@example.test`;
  const buyerEmail = `buyer-${suffix}@example.test`;
  const secondBuyerEmail = `second-buyer-${suffix}@example.test`;
  const adminPhone = `+6757${crypto.randomInt(1000000, 9999999)}`;
  const vendorPhone = `+6758${crypto.randomInt(1000000, 9999999)}`;
  const secondVendorPhone = `+6757${crypto.randomInt(1000000, 9999999)}`;
  const buyerPhone = `+6757${crypto.randomInt(1000000, 9999999)}`;
  const secondBuyerPhone = `+6758${crypto.randomInt(1000000, 9999999)}`;
  const password = 'IntegrationPassword-675!';
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'));
  const productAdditionalDetails = {
    brand: 'Test Brand', model: 'Test Model', dimensions: '10 x 20 cm',
    materials: 'Test material', origin: 'Test origin', warranty: 'No warranty',
    deliveryAreas: 'NCD and Morobe', dispatchTime: '1 business day',
    deliveryEstimate: '2 to 4 business days', pickupDetails: 'Pickup by arrangement',
    deliveryRestrictions: 'No restrictions'
  };
  function vendorDeliveryContacts() {
    return [{
      province: freightRoute.origin, name: 'Test Driver', phone: vendorPhone,
      transport: 'Test PMV', route: `${freightRoute.origin} to ${freightRoute.destination}`
    }];
  }
  function differentProvince(province) {
    return province === 'Madang' ? 'NCD' : 'Madang';
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(function (resolve) { server.once('listening', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let adminId = null;
  let buyerId = null;
  let secondBuyerId = null;
  let vendorId = null;
  let freightRoute = null;
  let crossFreightDestination = null;
  const uploadedImagePaths = [];

  async function request(route, options) {
    return fetch(baseUrl + route, Object.assign({ headers: {} }, options || {}));
  }

  async function postJson(route, body, cookie, extraHeaders) {
    return request(route, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}, cookie ? { Cookie: cookie } : {}),
      body: JSON.stringify(body)
    });
  }

  async function login(email) {
    const response = await postJson('/api/auth/login', { email, password });
    assert.equal(response.status, 200);
    return (response.headers.get('set-cookie') || '').split(';')[0];
  }

  try {
    const routes = await query(
      `SELECT origins.origin AS origin, destinations.destination AS destination, providers.provider
         FROM unnest(ARRAY['NCD','Morobe','Western Highlands','East New Britain','Eastern Highlands','Madang',
           'Milne Bay','East Sepik','West Sepik','Bougainville','Manus','New Ireland','West New Britain',
           'Central','Gulf','Oro','Western','Southern Highlands','Enga','Hela','Jiwaka','Chimbu']::text[]) origins(origin)
         CROSS JOIN unnest(ARRAY['NCD','Morobe','Western Highlands','East New Britain','Eastern Highlands','Madang',
           'Milne Bay','East Sepik','West Sepik','Bougainville','Manus','New Ireland','West New Britain',
           'Central','Gulf','Oro','Western','Southern Highlands','Enga','Hela','Jiwaka','Chimbu']::text[]) destinations(destination)
         CROSS JOIN unnest(ARRAY['PMV']::text[]) providers(provider)
        WHERE origins.origin = destinations.destination
          AND NOT EXISTS (
            SELECT 1 FROM freight_rates f
             WHERE f.origin_province = origins.origin
               AND f.destination_province = destinations.destination
               AND f.provider = providers.provider
          )
        LIMIT 1`
    );
    assert.ok(routes.rows[0], 'Test database needs one unused route for an isolated freight fixture.');
    freightRoute = routes.rows[0];
    const passwordHash = await bcrypt.hash(password, 10);
    const createdAdmin = await query(
      `INSERT INTO users (full_name, email, phone_number, home_province, role, password_hash)
       VALUES ('Test Administrator', $1, $2, 'NCD', 'admin', $3) RETURNING user_id`,
      [adminEmail, adminPhone, passwordHash]
    );
    adminId = createdAdmin.rows[0].user_id;
    const adminCookie = await login(adminEmail);
    assert.equal((await request('/admin-dashboard.html', { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await request('/admin-orders.html', { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await request('/vendor-dashboard.html', { headers: { Cookie: adminCookie } })).status, 403);

    const missingVendorSetup = await postJson('/api/auth/register', {
      fullName: 'Test Vendor', email: vendorEmail, phoneNumber: vendorPhone,
      password, role: 'vendor', homeProvince: freightRoute.origin
    });
    assert.equal(missingVendorSetup.status, 400, 'Vendor registration requires the business payment setup.');
    const registration = await postJson('/api/auth/register', {
      fullName: 'Test Vendor', email: vendorEmail, phoneNumber: vendorPhone,
      password, role: 'vendor', homeProvince: freightRoute.origin,
      businessName: `Test Shop ${suffix.slice(0, 8)}`, businessProvince: freightRoute.origin,
      vendorPaymentMethods: [
        { id: 'bank_transfer', instructions: 'Transfer to the test vendor bank account.', referencePhone: vendorPhone },
        { id: 'mobile_wallet', instructions: 'Pay the test vendor using its listed wallet.', referenceWhatsapp: vendorPhone },
        { id: 'cash_on_delivery', instructions: 'Pay the test vendor upon delivery.' },
        { id: 'in_person', instructions: 'Arrange in-person payment with the test vendor.' }
      ]
    });
    assert.equal(registration.status, 201);
    const vendorCookie = (registration.headers.get('set-cookie') || '').split(';')[0];
    const vendor = (await registration.json()).user;
    assert.equal((await request('/vendor-dashboard.html', { headers: { Cookie: vendorCookie } })).status, 200);
    assert.equal((await request('/vendor-products.html', { headers: { Cookie: vendorCookie } })).status, 403);
    assert.equal((await request('/vendor-product-form.html', { headers: { Cookie: vendorCookie } })).status, 403);

    const application = await postJson('/api/vendor/profile', {
      businessName: `Test Shop ${suffix.slice(0, 8)}`, province: freightRoute.origin,
      paymentMethods: [
        { id: 'bank_transfer', instructions: 'Transfer to the test vendor bank account.', referencePhone: vendorPhone },
        { id: 'mobile_wallet', instructions: 'Pay the test vendor using its listed wallet.', referenceWhatsapp: vendorPhone },
        { id: 'cash_on_delivery', instructions: 'Pay the test vendor upon delivery.' },
        { id: 'in_person', instructions: 'Arrange in-person payment with the test vendor.' }
      ]
    }, vendorCookie);
    assert.equal(application.status, 200);
    vendorId = (await application.json()).vendor.vendor_id;
    const invalidReferenceContact = await request('/api/vendor/payment-methods', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ paymentMethods: [{ id: 'bank_transfer', instructions: 'Transfer to the test vendor bank account.' }] })
    });
    assert.equal(invalidReferenceContact.status, 400, 'Bank transfer requires a phone or WhatsApp reference contact.');
    assert.equal((await request('/vendor-orders.html', { headers: { Cookie: vendorCookie } })).status, 403);

    const pendingDenied = await postJson('/api/vendor/products', {
      name: 'Test Item', category: 'Test', province: freightRoute.origin,
      deliveryType: 'both', priceKina: 17.35, stockQuantity: 5
    }, vendorCookie);
    assert.equal(pendingDenied.status, 403);

    const approval = await request(`/api/admin/vendors/${vendorId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'active' })
    });
    assert.equal(approval.status, 200);
    assert.equal((await request('/vendor-products.html', { headers: { Cookie: vendorCookie } })).status, 200);
    assert.equal((await request('/vendor-product-form.html', { headers: { Cookie: vendorCookie } })).status, 200);

    const missingDeliveryType = await postJson('/api/vendor/products', {
      name: 'Missing delivery type', category: 'Test Category', province: freightRoute.origin,
      priceKina: 17.35, stockQuantity: 5
    }, vendorCookie);
    assert.equal(missingDeliveryType.status, 400);

    const missingCondition = await postJson('/api/vendor/products', {
      name: 'Missing condition', category: 'Test Category', description: 'A detailed test description for this product.',
      province: freightRoute.origin, deliveryType: 'both', priceUnit: 'each', priceKina: 17.35, stockQuantity: 5
    }, vendorCookie);
    assert.equal(missingCondition.status, 400);

    const shortDescription = await postJson('/api/vendor/products', {
      name: 'Short description', category: 'Test Category', description: 'Too short.',
      province: freightRoute.origin, deliveryType: 'both', condition: 'new', priceUnit: 'each',
      priceKina: 17.35, stockQuantity: 5
    }, vendorCookie);
    assert.equal(shortDescription.status, 400);

    const missingLocalDriver = await postJson('/api/vendor/products', {
      name: 'Delivery without local driver', category: 'Test Category',
      description: 'A detailed delivery listing missing its local transport contact.',
      province: freightRoute.origin, deliveryType: 'delivery', condition: 'new', priceUnit: 'item',
      ...productAdditionalDetails, deliveryContacts: [],
      priceKina: 17.35, stockQuantity: 2
    }, vendorCookie);
    assert.equal(missingLocalDriver.status, 400,
      'Delivery listings cannot be published without the required local driver/skipper contact.');
    const pickupWithoutDriver = await postJson('/api/vendor/products', {
      name: 'Pickup without local driver', category: 'Test Category',
      description: 'A detailed pickup-only listing does not need a local transport contact.',
      province: freightRoute.origin, deliveryType: 'pickup', condition: 'new', priceUnit: 'item',
      ...productAdditionalDetails, deliveryContacts: [],
      priceKina: 17.35, stockQuantity: 0
    }, vendorCookie);
    assert.equal(pickupWithoutDriver.status, 201);
    assert.deepEqual((await pickupWithoutDriver.json()).product.delivery_contacts, []);

    const missingPriceUnit = await postJson('/api/vendor/products', {
      name: 'Missing price unit', category: 'Test Category', description: 'A detailed test description for this product.',
      province: freightRoute.origin, deliveryType: 'both', condition: 'new', priceKina: 17.35, stockQuantity: 5
    }, vendorCookie);
    assert.equal(missingPriceUnit.status, 400);

    const incompleteProductDetails = Object.assign({
      name: 'Incomplete product details', category: 'Test Category',
      description: 'A detailed description with one required specification missing.',
      province: freightRoute.origin, deliveryType: 'both', condition: 'new', priceUnit: 'item',
      priceKina: 17.35, stockQuantity: 5
    }, productAdditionalDetails);
    delete incompleteProductDetails.brand;
    const incompleteDetailsResponse = await postJson('/api/vendor/products', incompleteProductDetails, vendorCookie);
    assert.equal(incompleteDetailsResponse.status, 400, 'New listings require every product and fulfillment detail.');

    const productResponse = await postJson('/api/vendor/products', {
      name: 'Test Item', category: 'Test Category', description: 'A detailed description of the disposable integration fixture.',
      province: freightRoute.origin, deliveryType: 'both', condition: 'used', priceUnit: 'pair',
      deliveryNotes: 'Pickup available by arrangement.', ...productAdditionalDetails,
      deliveryContacts: vendorDeliveryContacts(),
      priceKina: 17.35, stockQuantity: 5, imageUrl: ''
    }, vendorCookie);
    assert.equal(productResponse.status, 201);
    const product = (await productResponse.json()).product;
    assert.equal(product.delivery_type, 'both');
    assert.equal(product.item_condition, 'used');
    assert.equal(product.price_unit, 'pair');
    assert.equal(product.delivery_notes, 'Pickup available by arrangement.');
    assert.deepEqual(product.additional_details, productAdditionalDetails);
    assert.deepEqual(product.delivery_contacts, vendorDeliveryContacts());
    assert.equal((await request(`/vendor-product-form.html?id=${product.product_id}`, { headers: { Cookie: vendorCookie } })).status, 200);
    const deliveryTypeUpdate = await request(`/api/vendor/products/${product.product_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ deliveryType: 'delivery' })
    });
    assert.equal(deliveryTypeUpdate.status, 200);
    assert.equal((await deliveryTypeUpdate.json()).product.delivery_type, 'delivery');
    const provinceChangeWithoutContact = await request(`/api/vendor/products/${product.product_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ province: differentProvince(freightRoute.origin) })
    });
    assert.equal(provinceChangeWithoutContact.status, 400,
      'Changing a delivery listing province requires the replacement local transport contact.');
    const additionalDetailUpdate = await request(`/api/vendor/products/${product.product_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ deliveryAreas: 'NCD only' })
    });
    assert.equal(additionalDetailUpdate.status, 200);
    assert.equal((await additionalDetailUpdate.json()).product.additional_details.deliveryAreas, 'NCD only');
    const productDetails = await (await request(`/api/products/${product.product_id}`)).json();
    assert.equal(productDetails.product.item_condition, 'used');
    assert.equal(productDetails.product.price_unit, 'pair');
    assert.equal(productDetails.product.delivery_notes, 'Pickup available by arrangement.');
    assert.equal(productDetails.product.description, 'A detailed description of the disposable integration fixture.');
    assert.equal(productDetails.product.additional_details.deliveryAreas, 'NCD only');
    assert.equal(Object.prototype.hasOwnProperty.call(productDetails.product, 'delivery_contacts'), false,
      'Driver/skipper contacts are not exposed on public product details.');

    const imageUpload = new FormData();
    Object.entries({
      name: 'Uploaded image test item', category: 'Test Category',
      description: 'A detailed description for the uploaded image integration fixture.',
      province: freightRoute.origin, deliveryType: 'both', condition: 'new', priceUnit: 'item',
      ...productAdditionalDetails, deliveryContacts: JSON.stringify(vendorDeliveryContacts()), priceKina: '2.5', stockQuantity: '1'
    }).forEach(function (entry) { imageUpload.append(entry[0], entry[1]); });
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
    imageUpload.append('productImage', new Blob([pngHeader], { type: 'image/png' }), 'fixture.png');
    const uploadedProductResponse = await request('/api/vendor/products', {
      method: 'POST', headers: { Cookie: vendorCookie }, body: imageUpload
    });
    assert.equal(uploadedProductResponse.status, 201);
    const uploadedProduct = (await uploadedProductResponse.json()).product;
    const uploadedProductImage = await query('SELECT image_url FROM products WHERE product_id = $1', [uploadedProduct.product_id]);
    assert.match(uploadedProductImage.rows[0].image_url, /^\/uploads\/products\/[0-9a-f-]+\.png$/i);
    uploadedImagePaths.push(uploadedProductImage.rows[0].image_url);
    const uploadedImageResponse = await request(uploadedProductImage.rows[0].image_url);
    assert.equal(uploadedImageResponse.status, 200);
    assert.equal(uploadedImageResponse.headers.get('content-type'), 'image/png');

    const fakeImage = new FormData();
    Object.entries({
      name: 'Spoofed image test item', category: 'Test Category',
      description: 'A detailed description for a spoofed image test fixture.',
      province: freightRoute.origin, deliveryType: 'both', condition: 'new', priceUnit: 'item',
      ...productAdditionalDetails, deliveryContacts: JSON.stringify(vendorDeliveryContacts()), priceKina: '2.5', stockQuantity: '1'
    }).forEach(function (entry) { fakeImage.append(entry[0], entry[1]); });
    fakeImage.append('productImage', new Blob(['not an image'], { type: 'image/png' }), 'spoof.png');
    const fakeImageResponse = await request('/api/vendor/products', {
      method: 'POST', headers: { Cookie: vendorCookie }, body: fakeImage
    });
    assert.equal(fakeImageResponse.status, 400, 'Spoofed image MIME types are rejected by file-signature checks.');

    const secondVendorRegistration = await postJson('/api/auth/register', {
      fullName: 'Second Test Vendor', email: secondVendorEmail, phoneNumber: secondVendorPhone,
      password, role: 'vendor', homeProvince: freightRoute.origin,
      businessName: `Second Shop ${suffix.slice(0, 8)}`, businessProvince: freightRoute.origin,
      vendorPaymentMethods: [
        { id: 'bank_transfer', instructions: 'Transfer to the second test vendor bank account.', referencePhone: secondVendorPhone },
        { id: 'mobile_wallet', instructions: 'Pay the second test vendor using its listed wallet.', referenceWhatsapp: secondVendorPhone },
        { id: 'cash_on_delivery', instructions: 'Pay the second test vendor upon delivery.' },
        { id: 'in_person', instructions: 'Arrange in-person payment with the second test vendor.' }
      ]
    });
    assert.equal(secondVendorRegistration.status, 201);
    const secondVendorCookie = (secondVendorRegistration.headers.get('set-cookie') || '').split(';')[0];
    const secondApplication = await postJson('/api/vendor/profile', {
      businessName: `Second Shop ${suffix.slice(0, 8)}`, province: freightRoute.origin,
      paymentMethods: [
        { id: 'bank_transfer', instructions: 'Transfer to the second test vendor bank account.', referencePhone: secondVendorPhone },
        { id: 'mobile_wallet', instructions: 'Pay the second test vendor using its listed wallet.', referenceWhatsapp: secondVendorPhone },
        { id: 'cash_on_delivery', instructions: 'Pay the second test vendor upon delivery.' },
        { id: 'in_person', instructions: 'Arrange in-person payment with the second test vendor.' }
      ]
    }, secondVendorCookie);
    assert.equal(secondApplication.status, 200);
    const secondVendorId = (await secondApplication.json()).vendor.vendor_id;
    const secondApproval = await request(`/api/admin/vendors/${secondVendorId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'active' })
    });
    assert.equal(secondApproval.status, 200);
    const secondProductResponse = await postJson('/api/vendor/products', {
      name: 'Second Test Item', category: 'Test Category', description: 'A detailed description of the second vendor fixture.',
      province: freightRoute.origin, deliveryType: 'both', condition: 'new', priceUnit: 'item',
      ...productAdditionalDetails, deliveryContacts: vendorDeliveryContacts(),
      priceKina: 8.25, stockQuantity: 3, imageUrl: ''
    }, secondVendorCookie);
    assert.equal(secondProductResponse.status, 201);
    const secondProduct = (await secondProductResponse.json()).product;
    const ownershipDenied = await request(`/api/vendor/products/${product.product_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: secondVendorCookie },
      body: JSON.stringify({ status: 'paused' })
    });
    assert.equal(ownershipDenied.status, 404);

    const catalog = await request('/api/products?category=all&minPrice=17.35&maxPrice=17.35&sort=price_asc');
    assert.equal(catalog.status, 200);
    const catalogBody = await catalog.json();
    assert.ok(catalogBody.products.some(function (item) { return item.product_id === product.product_id; }));
    const catalogProduct = catalogBody.products.find(function (item) { return item.product_id === product.product_id; });
    assert.equal(catalogProduct.delivery_type, 'delivery');
    assert.equal(Object.prototype.hasOwnProperty.call(catalogProduct, 'description'), false,
      'Product search results return concise listing data; the full description is fetched on the detail page.');
    assert.equal(Object.prototype.hasOwnProperty.call(catalogProduct, 'additional_details'), false,
      'Full specifications are fetched only when a customer opens the product.');
    assert.equal(Object.prototype.hasOwnProperty.call(catalogProduct, 'delivery_notes'), false,
      'Full delivery notes are fetched only when a customer opens the product.');
    const categoriesResponse = await request('/api/products/categories');
    assert.equal(categoriesResponse.status, 200);
    const categoriesBody = await categoriesResponse.json();
    assert.ok(categoriesBody.categories.includes('Test Category'));
    const filteredCatalog = await request('/api/products?category=' + encodeURIComponent('Test Category'));
    assert.equal(filteredCatalog.status, 200);
    const filteredCatalogBody = await filteredCatalog.json();
    assert.ok(filteredCatalogBody.products.some(function (item) {
      return item.product_id === product.product_id && item.category === 'Test Category';
    }));
    const detail = await request(`/api/products/${product.product_id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).product.delivery_type, 'delivery');

    const buyerRegistration = await postJson('/api/auth/register', {
      fullName: 'Test Buyer', email: buyerEmail, phoneNumber: buyerPhone,
      password, role: 'buyer', homeProvince: freightRoute.destination
    });
    assert.equal(buyerRegistration.status, 201);
    buyerId = (await buyerRegistration.json()).user.id;
    const buyerCookie = (buyerRegistration.headers.get('set-cookie') || '').split(';')[0];
    for (const page of ['/cart.html', '/checkout.html', '/account.html', '/orders.html']) {
      assert.equal((await request(page, { headers: { Cookie: buyerCookie } })).status, 200, page);
    }

    const deniedAdmin = await request('/api/admin/dashboard', { headers: { Cookie: buyerCookie } });
    assert.equal(deniedAdmin.status, 403);
    assert.equal((await request('/admin-dashboard.html', { headers: { Cookie: buyerCookie } })).status, 403);
    assert.equal((await request('/admin-orders.html', { headers: { Cookie: buyerCookie } })).status, 403);
    const deniedVendorDashboard = await request('/api/vendor/dashboard', { headers: { Cookie: buyerCookie } });
    assert.equal(deniedVendorDashboard.status, 403);
    const buyerPaymentEdit = await request('/api/vendor/payment-methods', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ paymentMethods: [{ id: 'bank_transfer', instructions: 'Attempted customer change.' }] })
    });
    assert.equal(buyerPaymentEdit.status, 403);
    assert.equal((await request('/vendor-dashboard.html', { headers: { Cookie: buyerCookie } })).status, 403);
    assert.equal((await request('/vendor-products.html', { headers: { Cookie: vendorCookie } })).status, 200);
    assert.equal((await request(`/vendor-product-form.html?id=${product.product_id}`, { headers: { Cookie: buyerCookie } })).status, 403);
    assert.equal((await request('/vendor-orders.html', { headers: { Cookie: vendorCookie } })).status, 200);

    const cart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(cart.status, 200);
    const buyerCart = await request('/api/cart', { headers: { Cookie: buyerCookie } });
    assert.equal(buyerCart.status, 200);
    const cartListing = (await buyerCart.json()).items.find(function (item) {
      return String(item.product_id) === String(product.product_id);
    });
    assert.equal(cartListing.local_delivery_available, true);
    assert.equal(Object.prototype.hasOwnProperty.call(cartListing, 'delivery_contacts'), false,
      'The cart exposes contact availability without exposing the private driver details.');
    const unavailablePickup = await postJson('/api/orders', {
      deliveryAddress: 'Test address for integration only',
      deliveryProvince: freightRoute.destination,
      phoneNumber: buyerPhone,
      shippingProvider: 'Pickup',
      paymentMethod: 'sandbox_test_record'
    }, buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(unavailablePickup.status, 409);
    assert.equal((await unavailablePickup.json()).code, 'delivery_method_unavailable');
    await request(`/api/vendor/products/${product.product_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ deliveryType: 'both' })
    });
    const invalidQuantity = await request(`/api/cart/items/${product.product_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ quantity: 0 })
    });
    assert.equal(invalidQuantity.status, 400);
    const missingIdempotencyKey = await postJson('/api/orders', {
      deliveryAddress: 'Test address for integration only',
      deliveryProvince: freightRoute.destination,
      phoneNumber: buyerPhone,
      shippingProvider: freightRoute.provider,
      paymentMethod: 'Sandbox'
    }, buyerCookie);
    assert.equal(missingIdempotencyKey.status, 400);

    const freight = await postJson('/api/freight/estimate', {
      originProvinces: [freightRoute.origin],
      destinationProvince: freightRoute.destination,
      provider: freightRoute.provider
    }, buyerCookie);
    assert.equal(freight.status, 503);

    const rate = await postJson('/api/admin/freight-rates', {
      originProvince: freightRoute.origin,
      destinationProvince: freightRoute.destination,
      provider: freightRoute.provider,
      amountKina: 0.75,
      isEstimate: true
    }, adminCookie);
    assert.equal(rate.status, 200);

    const quote = await postJson('/api/freight/estimate', {
      originProvinces: [freightRoute.origin],
      destinationProvince: freightRoute.destination,
      provider: freightRoute.provider
    }, buyerCookie);
    assert.equal(quote.status, 200);
    assert.equal((await quote.json()).amountKina, 0.75);
    const invalidLocalShipRate = await postJson('/api/admin/freight-rates', {
      originProvince: freightRoute.origin,
      destinationProvince: freightRoute.destination,
      provider: 'Ship',
      amountKina: 0.75,
      isEstimate: true
    }, adminCookie);
    assert.equal(invalidLocalShipRate.status, 400,
      'Admins cannot configure inter-province transport for a same-province route.');
    const invalidInterprovincePmvRate = await postJson('/api/admin/freight-rates', {
      originProvince: freightRoute.origin,
      destinationProvince: differentProvince(freightRoute.destination),
      provider: 'PMV',
      amountKina: 0.75,
      isEstimate: true
    }, adminCookie);
    assert.equal(invalidInterprovincePmvRate.status, 400,
      'Admins cannot configure local PMV as inter-province transport.');
    const obsoletePostPngQuote = await postJson('/api/freight/estimate', {
      originProvince: freightRoute.origin,
      destinationProvince: differentProvince(freightRoute.origin),
      provider: 'PostPNG'
    }, buyerCookie);
    assert.equal(obsoletePostPngQuote.status, 400, 'Legacy PostPNG rates cannot be used as an inter-province checkout method.');

    const idempotencyKey = crypto.randomUUID();
    const checkout = {
      deliveryAddress: 'Test address for integration only',
      deliveryProvince: freightRoute.destination,
      phoneNumber: buyerPhone,
      shippingProvider: freightRoute.provider,
      paymentMethod: 'sandbox_test_record',
      totalKina: 0.01
    };
    await query('UPDATE products SET delivery_contacts = $1::jsonb WHERE product_id = $2',
      [JSON.stringify([]), product.product_id]);
    const cartWithoutDriver = await request('/api/cart', { headers: { Cookie: buyerCookie } });
    assert.equal(cartWithoutDriver.status, 200);
    const cartListingWithoutDriver = (await cartWithoutDriver.json()).items.find(function (item) {
      return String(item.product_id) === String(product.product_id);
    });
    assert.equal(cartListingWithoutDriver.local_delivery_available, false);
    const unavailableLocalCheckout = await postJson('/api/orders', checkout, buyerCookie, {
      'Idempotency-Key': crypto.randomUUID()
    });
    assert.equal(unavailableLocalCheckout.status, 409);
    assert.equal((await unavailableLocalCheckout.json()).code, 'delivery_contact_unavailable');
    await query('UPDATE products SET delivery_contacts = $1::jsonb WHERE product_id = $2',
      [JSON.stringify(vendorDeliveryContacts()), product.product_id]);
    const unsupportedDestination = differentProvince(freightRoute.destination);
    crossFreightDestination = unsupportedDestination;
    const missingDestinationContact = await postJson('/api/orders', Object.assign({}, checkout, {
      deliveryProvince: unsupportedDestination, shippingProvider: 'PMV'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(missingDestinationContact.status, 409);
    assert.equal((await missingDestinationContact.json()).code, 'delivery_route_unavailable');
    const shipRate = await postJson('/api/admin/freight-rates', {
      originProvince: freightRoute.origin,
      destinationProvince: unsupportedDestination,
      provider: 'Ship',
      amountKina: 1.25,
      isEstimate: true
    }, adminCookie);
    assert.equal(shipRate.status, 200);
    const crossProvinceOrderResponse = await postJson('/api/orders', Object.assign({}, checkout, {
      deliveryProvince: unsupportedDestination, shippingProvider: 'Ship'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(crossProvinceOrderResponse.status, 201);
    const crossProvinceOrder = (await crossProvinceOrderResponse.json()).order;
    const crossProvinceDetails = await request(`/api/orders/${crossProvinceOrder.order_id}`, {
      headers: { Cookie: buyerCookie }
    });
    assert.equal(crossProvinceDetails.status, 200);
    assert.equal((await crossProvinceDetails.json()).order.items[0].deliveryContact, null,
      'Inter-province ship orders do not expose local driver/skipper contacts.');
    const crossProvinceCancelled = await request(`/api/orders/${crossProvinceOrder.order_id}/cancel`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(crossProvinceCancelled.status, 200);
    const localCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ quantity: 1 })
    });
    assert.equal(localCart.status, 200);
    const pmvOrderResponse = await postJson('/api/orders', Object.assign({}, checkout, {
      deliveryProvince: freightRoute.origin,
      shippingProvider: 'PMV',
      paymentMethod: 'cash_on_delivery'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(pmvOrderResponse.status, 201);
    const pmvOrder = (await pmvOrderResponse.json()).order;
    for (const status of ['confirmed', 'packed']) {
      const statusResponse = await request(`/api/vendor/orders/${pmvOrder.order_id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
        body: JSON.stringify({ status })
      });
      assert.equal(statusResponse.status, 200);
    }
    const pmvDispatchWithoutDriver = await request(`/api/vendor/orders/${pmvOrder.order_id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ status: 'shipped' })
    });
    assert.equal(pmvDispatchWithoutDriver.status, 409);
    assert.equal((await pmvDispatchWithoutDriver.json()).code, 'pmv_driver_details_required');
    const pmvMissingDriver = await request(`/api/vendor/orders/${pmvOrder.order_id}/shipment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ notes: 'PMV test shipment' })
    });
    assert.equal(pmvMissingDriver.status, 400);
    assert.equal((await pmvMissingDriver.json()).code, 'invalid_pmv_driver_details');
    const pmvShipment = await request(`/api/vendor/orders/${pmvOrder.order_id}/shipment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({
        driverName: 'Test PMV Driver',
        driverPhone: vendorPhone,
        vehiclePlate: 'ABC 123',
        vehicleDescription: 'Blue minibus'
      })
    });
    assert.equal(pmvShipment.status, 200);
    const pmvBuyerDetail = await request(`/api/orders/${pmvOrder.order_id}`, { headers: { Cookie: buyerCookie } });
    assert.equal(pmvBuyerDetail.status, 200);
    const pmvShipmentDetails = (await pmvBuyerDetail.json()).order;
    assert.equal(pmvShipmentDetails.shipment_driver_name, 'Test PMV Driver');
    assert.equal(pmvShipmentDetails.shipment_driver_phone, vendorPhone);
    assert.equal(pmvShipmentDetails.shipment_vehicle_plate, 'ABC 123');
    assert.equal(pmvShipmentDetails.shipment_vehicle_description, 'Blue minibus');
    const pmvPayment = await query('SELECT payment_id FROM payments WHERE order_id = $1', [pmvOrder.order_id]);
    const releasePmvReservation = await postJson(`/api/admin/payments/${pmvPayment.rows[0].payment_id}/verify`, {
      status: 'failed',
      failureReason: 'Release PMV driver-details test reservation.'
    }, adminCookie);
    assert.equal(releasePmvReservation.status, 200);
    const restoreCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(restoreCart.status, 200);
    const firstOrder = await postJson('/api/orders', checkout, buyerCookie, { 'Idempotency-Key': idempotencyKey });
    assert.equal(firstOrder.status, 201);
    const order = (await firstOrder.json()).order;
    assert.equal(Number(order.total_kina), 18.10);
    const buyerOrderDetails = await request(`/api/orders/${order.order_id}`, { headers: { Cookie: buyerCookie } });
    assert.equal(buyerOrderDetails.status, 200);
    const driverContact = (await buyerOrderDetails.json()).order.items[0].deliveryContact;
    assert.equal(driverContact.phone, vendorPhone);
    assert.equal(driverContact.province, freightRoute.destination);
    const driverContactDashboard = await request('/api/vendor/dashboard', { headers: { Cookie: vendorCookie } });
    assert.equal(driverContactDashboard.status, 200);
    assert.ok((await driverContactDashboard.json()).orders[0].delivery_contacts.some(function (entry) {
      return entry.contact && entry.contact.phone === vendorPhone;
    }), 'The vendor can see the contact details for the vendor order.');

    const replay = await postJson('/api/orders', checkout, buyerCookie, { 'Idempotency-Key': idempotencyKey });
    assert.equal(replay.status, 200);
    assert.equal(String((await replay.json()).order.order_id), String(order.order_id));

    const changedRetry = await postJson('/api/orders', Object.assign({}, checkout, { deliveryAddress: 'Different address for this order' }), buyerCookie, { 'Idempotency-Key': idempotencyKey });
    assert.equal(changedRetry.status, 409);

    const payments = await query('SELECT status, mode FROM payments WHERE order_id = $1', [order.order_id]);
    assert.equal(payments.rows.length, 1);
    assert.equal(payments.rows[0].status, 'pending');
    assert.equal(payments.rows[0].mode, 'sandbox');

    const paymentMethods = await request('/api/payments/methods');
    assert.equal(paymentMethods.status, 200);
    assert.deepEqual((await paymentMethods.json()).methods.map(function (method) { return method.id; }), [
      'sandbox_test_record', 'manual_bank_transfer', 'cash_on_delivery', 'in_person'
    ]);
    const forgedCallback = await postJson('/api/payments/webhooks/bsp_pay', {
      status: 'successful', orderId: order.order_id, transactionReference: 'forged'
    });
    assert.equal(forgedCallback.status, 404);
    const duplicateForgedCallback = await postJson('/api/payments/webhooks/bsp_pay', {
      status: 'successful', orderId: order.order_id, transactionReference: 'forged'
    });
    assert.equal(duplicateForgedCallback.status, 404);
    const stillPending = await query('SELECT status FROM payments WHERE order_id = $1', [order.order_id]);
    assert.equal(stillPending.rows[0].status, 'pending');

    const remainingStock = await query('SELECT stock_quantity FROM products WHERE product_id = $1', [product.product_id]);
    assert.equal(remainingStock.rows[0].stock_quantity, 5);
    const oversell = await request(`/api/cart/items/${product.product_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ quantity: 5 })
    });
    assert.equal(oversell.status, 409);

    const manualCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(manualCart.status, 200);
    const manualOrderResponse = await postJson('/api/orders', Object.assign({}, checkout, {
      paymentMethod: 'manual_bank_transfer'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(manualOrderResponse.status, 201);
    const manualOrder = (await manualOrderResponse.json()).order;
    const manualPayment = await query(
      'SELECT payment_id, status, mode FROM payments WHERE order_id = $1',
      [manualOrder.order_id]
    );
    assert.equal(manualPayment.rows[0].mode, 'manual');
    assert.equal(manualPayment.rows[0].status, 'pending');
    const buyerVerifyDenied = await postJson(`/api/admin/payments/${manualPayment.rows[0].payment_id}/verify`, {
      status: 'successful', verificationReference: 'untrusted-user-input'
    }, buyerCookie);
    assert.equal(buyerVerifyDenied.status, 403);
    const verifiedPayment = await postJson(`/api/admin/payments/${manualPayment.rows[0].payment_id}/verify`, {
      status: 'successful', verificationReference: `bank-confirmed-${suffix}`
    }, adminCookie);
    assert.equal(verifiedPayment.status, 200);
    assert.equal((await verifiedPayment.json()).payment.status, 'successful');
    const paidOrder = await query('SELECT payment_status FROM orders WHERE order_id = $1', [manualOrder.order_id]);
    assert.equal(paidOrder.rows[0].payment_status, 'successful');
    const duplicateVerification = await postJson(`/api/admin/payments/${manualPayment.rows[0].payment_id}/verify`, {
      status: 'successful', verificationReference: `bank-confirmed-${suffix}`
    }, adminCookie);
    assert.equal(duplicateVerification.status, 200);
    const fulfilledStock = await query('SELECT stock_quantity FROM products WHERE product_id = $1', [product.product_id]);
    assert.equal(fulfilledStock.rows[0].stock_quantity, 4);

    const failedCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(failedCart.status, 200);
    const failedOrderResponse = await postJson('/api/orders', Object.assign({}, checkout, {
      paymentMethod: 'cash_on_delivery'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(failedOrderResponse.status, 201);
    const failedOrder = (await failedOrderResponse.json()).order;
    const failedPayment = await query('SELECT payment_id FROM payments WHERE order_id = $1', [failedOrder.order_id]);
    const failedVerification = await postJson(`/api/admin/payments/${failedPayment.rows[0].payment_id}/verify`, {
      status: 'failed', failureReason: 'Receipt was not collected.'
    }, adminCookie);
    assert.equal(failedVerification.status, 200);
    const failedState = await query(
      `SELECT pay.status, o.payment_status, o.order_status
         FROM payments pay JOIN orders o ON o.order_id = pay.order_id
        WHERE pay.order_id = $1`,
      [failedOrder.order_id]
    );
    assert.equal(failedState.rows[0].status, 'failed');
    assert.equal(failedState.rows[0].payment_status, 'failed');
    assert.equal(failedState.rows[0].order_status, 'cancelled');
    const failedPhysicalStock = await query('SELECT stock_quantity FROM products WHERE product_id = $1', [product.product_id]);
    assert.equal(failedPhysicalStock.rows[0].stock_quantity, 4);
    const releasedStock = await query(
      `SELECT COALESCE(SUM(quantity), 0) AS reserved FROM inventory_reservations
        WHERE product_id = $1 AND status = 'reserved' AND expires_at > clock_timestamp()`,
      [product.product_id]
    );
    assert.equal(Number(releasedStock.rows[0].reserved), 1);

    const expiryCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(expiryCart.status, 200);
    const expiryOrderResponse = await postJson('/api/orders', Object.assign({}, checkout, {
      paymentMethod: 'in_person'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(expiryOrderResponse.status, 201);
    const expiryOrder = (await expiryOrderResponse.json()).order;
    await query('UPDATE payments SET expires_at = NOW() - INTERVAL \'1 second\' WHERE order_id = $1', [expiryOrder.order_id]);
    const expirySweep = await request('/api/payments/methods');
    assert.equal(expirySweep.status, 200);
    const expiredPayment = await query(
      `SELECT pay.status, o.payment_status, o.order_status
         FROM payments pay JOIN orders o ON o.order_id = pay.order_id
        WHERE pay.order_id = $1`,
      [expiryOrder.order_id]
    );
    assert.equal(expiredPayment.rows[0].status, 'expired');
    assert.equal(expiredPayment.rows[0].payment_status, 'expired');
    assert.equal(expiredPayment.rows[0].order_status, 'cancelled');
    const expiredReservation = await query(
      'SELECT status FROM inventory_reservations WHERE order_id = $1',
      [expiryOrder.order_id]
    );
    assert.equal(expiredReservation.rows[0].status, 'expired');

    const cancelledCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(cancelledCart.status, 200);
    const cancelledOrderResponse = await postJson('/api/orders', Object.assign({}, checkout, {
      paymentMethod: 'sandbox_test_record'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(cancelledOrderResponse.status, 201);
    const cancelledOrder = (await cancelledOrderResponse.json()).order;
    const cancelled = await request(`/api/orders/${cancelledOrder.order_id}/cancel`, {
      method: 'POST', headers: { Cookie: buyerCookie }
    });
    assert.equal(cancelled.status, 200);
    const cancelledState = await query('SELECT status FROM payments WHERE order_id = $1', [cancelledOrder.order_id]);
    assert.equal(cancelledState.rows[0].status, 'cancelled');
    const cancelledReservation = await query(
      'SELECT status FROM inventory_reservations WHERE order_id = $1',
      [cancelledOrder.order_id]
    );
    assert.equal(cancelledReservation.rows[0].status, 'released');

    const secondBuyerRegistration = await postJson('/api/auth/register', {
      fullName: 'Second Test Buyer', email: secondBuyerEmail, phoneNumber: secondBuyerPhone,
      password, role: 'buyer', homeProvince: freightRoute.destination
    });
    assert.equal(secondBuyerRegistration.status, 201);
    secondBuyerId = (await secondBuyerRegistration.json()).user.id;
    const secondBuyerCookie = (secondBuyerRegistration.headers.get('set-cookie') || '').split(';')[0];
    const firstRaceCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ quantity: 3 })
    });
    const secondRaceCart = await request(`/api/cart/items/${product.product_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: secondBuyerCookie },
      body: JSON.stringify({ quantity: 3 })
    });
    assert.equal(firstRaceCart.status, 200);
    assert.equal(secondRaceCart.status, 200);
    const race = await Promise.all([
      postJson('/api/orders', Object.assign({}, checkout, { paymentMethod: 'manual_bank_transfer' }),
        buyerCookie, { 'Idempotency-Key': crypto.randomUUID() }),
      postJson('/api/orders', Object.assign({}, checkout, { paymentMethod: 'manual_bank_transfer' }),
        secondBuyerCookie, { 'Idempotency-Key': crypto.randomUUID() })
    ]);
    assert.deepEqual(race.map(function (response) { return response.status; }).sort(), [201, 409]);
    const activeReservations = await query(
      `SELECT COALESCE(SUM(quantity), 0) AS reserved FROM inventory_reservations
        WHERE product_id = $1 AND status = 'reserved' AND expires_at > clock_timestamp()`,
      [product.product_id]
    );
    const physicalStock = await query('SELECT stock_quantity FROM products WHERE product_id = $1', [product.product_id]);
    assert.ok(Number(activeReservations.rows[0].reserved) <= Number(physicalStock.rows[0].stock_quantity));
    const winningOrder = (await race.find(function (response) { return response.status === 201; }).json()).order;
    const winningPayment = await query('SELECT payment_id FROM payments WHERE order_id = $1', [winningOrder.order_id]);
    const repricedOrderResponse = await request(`/api/admin/orders/${winningOrder.order_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        deliveryProvince: unsupportedDestination,
        shippingProvider: 'Ship'
      })
    });
    assert.equal(repricedOrderResponse.status, 200);
    const repricedOrder = (await repricedOrderResponse.json()).order;
    assert.equal(Number(repricedOrder.shipping_kina), 1.25);
    assert.equal(Number(repricedOrder.total_kina), Number(repricedOrder.subtotal_kina) + 1.25,
      'Admin route corrections reprice freight and the total using configured rates.');
    const repricedPayment = await query('SELECT amount_kina FROM payments WHERE order_id = $1', [winningOrder.order_id]);
    assert.equal(Number(repricedPayment.rows[0].amount_kina), Number(repricedOrder.total_kina),
      'Pending payment amount stays synchronized with the repriced order total.');
    const duplicateReceipt = await postJson(`/api/admin/payments/${winningPayment.rows[0].payment_id}/verify`, {
      status: 'successful', verificationReference: `bank-confirmed-${suffix}`
    }, adminCookie);
    assert.equal(duplicateReceipt.status, 409);
    const releaseWinner = await postJson(`/api/admin/payments/${winningPayment.rows[0].payment_id}/verify`, {
      status: 'failed', failureReason: 'Concurrent inventory reservation test cleanup.'
    }, adminCookie);
    assert.equal(releaseWinner.status, 200);

    await query('DELETE FROM cart_items WHERE user_id = ANY($1::bigint[])', [[buyerId, secondBuyerId]]);
    for (const productId of [product.product_id, secondProduct.product_id]) {
      const added = await request(`/api/cart/items/${productId}`, {
        method: 'POST', headers: { Cookie: buyerCookie }
      });
      assert.equal(added.status, 200);
    }
    const legacyMixedCheckout = await postJson('/api/orders', Object.assign({}, checkout, {
      paymentMethod: 'sandbox_test_record'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(legacyMixedCheckout.status, 409, 'The compatibility checkout endpoint refuses mixed-vendor carts.');
    assert.equal((await legacyMixedCheckout.json()).code, 'split_checkout_required');
    const splitKey = crypto.randomUUID();
    const splitCheckout = {
      deliveryAddress: 'Test address for split vendor orders',
      deliveryProvince: freightRoute.destination,
      phoneNumber: buyerPhone,
      shippingProvider: freightRoute.provider,
      shippingPayer: 'vendor',
      vendorPaymentMethods: [
        { vendorId: String(vendorId), methodId: 'bank_transfer' },
        { vendorId: String(secondVendorId), methodId: 'mobile_wallet' }
      ]
    };
    const invalidShippingPayer = await postJson('/api/checkout', Object.assign({}, splitCheckout, {
      shippingPayer: 'driver'
    }), buyerCookie, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(invalidShippingPayer.status, 400);
    assert.equal((await invalidShippingPayer.json()).code, 'invalid_checkout');
    const splitResponse = await postJson('/api/checkout', splitCheckout, buyerCookie, { 'Idempotency-Key': splitKey });
    assert.equal(splitResponse.status, 201);
    const splitBody = await splitResponse.json();
    assert.equal(splitBody.orders.length, 2);
    assert.equal(splitBody.paymentStatus, 'pending');
    const firstVendorOrder = splitBody.orders.find(function (item) { return String(item.vendor_id) === String(vendorId); });
    const secondVendorOrder = splitBody.orders.find(function (item) { return String(item.vendor_id) === String(secondVendorId); });
    assert.ok(firstVendorOrder && secondVendorOrder);
    for (const order of [firstVendorOrder, secondVendorOrder]) {
      assert.equal(order.shipping_payer, 'vendor');
      assert.equal(Number(order.total_kina), Number(order.subtotal_kina),
        'Vendor-paid delivery is excluded from the buyer payment total.');
      const payment = await query('SELECT amount_kina FROM payments WHERE order_id = $1', [order.order_id]);
      assert.equal(Number(payment.rows[0].amount_kina), Number(order.subtotal_kina));
    }
    assert.equal(firstVendorOrder.payment_method, 'manual_bank_transfer');
    assert.equal(firstVendorOrder.payment_reference_phone, vendorPhone);
    assert.equal(firstVendorOrder.payment_instructions, 'Transfer to the test vendor bank account.');
    assert.equal(secondVendorOrder.payment_method, 'mobile_wallet');
    assert.equal(secondVendorOrder.payment_reference_whatsapp, secondVendorPhone);
    assert.equal(secondVendorOrder.payment_instructions, 'Pay the second test vendor using its listed wallet.');
    const vendorDashboard = await request('/api/vendor/dashboard', { headers: { Cookie: vendorCookie } });
    assert.equal(vendorDashboard.status, 200);
    const vendorOrders = (await vendorDashboard.json()).orders;
    const fulfilledBuyerOrder = vendorOrders.find(function (item) {
      return String(item.order_id) === String(firstVendorOrder.order_id);
    });
    assert.equal(fulfilledBuyerOrder.buyer_name, 'Test Buyer');
    assert.equal(fulfilledBuyerOrder.delivery_address, splitCheckout.deliveryAddress);
    assert.equal(fulfilledBuyerOrder.phone_number, buyerPhone);
    assert.equal(fulfilledBuyerOrder.shipping_provider, freightRoute.provider);
    assert.equal(fulfilledBuyerOrder.shipping_payer, 'vendor');
    const splitReplay = await postJson('/api/checkout', splitCheckout, buyerCookie, { 'Idempotency-Key': splitKey });
    assert.equal(splitReplay.status, 200);
    assert.equal((await splitReplay.json()).orders.length, 2);
    const splitOrderCount = await query(
      'SELECT COUNT(*)::integer AS count FROM orders WHERE buyer_id = $1 AND checkout_group_key = $2',
      [buyerId, splitKey]
    );
    assert.equal(splitOrderCount.rows[0].count, 2);
    const splitDetails = await request(`/api/orders/${secondVendorOrder.order_id}`, { headers: { Cookie: buyerCookie } });
    assert.equal(splitDetails.status, 200);
    const secondOrderDetails = (await splitDetails.json()).order;
    assert.equal(secondOrderDetails.payment_instructions, 'Pay the second test vendor using its listed wallet.');
    assert.equal(secondOrderDetails.shipping_payer, 'vendor');
    assert.equal(secondOrderDetails.vendor_confirmed_receipt, false);

    const wrongVendorReceipt = await postJson(`/api/vendor/orders/${secondVendorOrder.order_id}/payment-confirmation`, {}, vendorCookie);
    assert.equal(wrongVendorReceipt.status, 404);
    const vendorReceipt = await postJson(`/api/vendor/orders/${secondVendorOrder.order_id}/payment-confirmation`, {
      verificationReference: `wallet-receipt-${suffix}`
    }, secondVendorCookie);
    assert.equal(vendorReceipt.status, 200);
    assert.equal((await vendorReceipt.json()).confirmationType, 'vendor_attestation');
    const repeatedVendorReceipt = await postJson(`/api/vendor/orders/${secondVendorOrder.order_id}/payment-confirmation`, {}, secondVendorCookie);
    assert.equal(repeatedVendorReceipt.status, 200);
    const vendorReceiptAudit = await query(
      'SELECT vendor_id, status, receipt_reference FROM vendor_payment_verifications WHERE order_id = $1',
      [secondVendorOrder.order_id]
    );
    assert.equal(String(vendorReceiptAudit.rows[0].vendor_id), String(secondVendorId));
    assert.equal(vendorReceiptAudit.rows[0].status, 'successful');
    assert.equal(vendorReceiptAudit.rows[0].receipt_reference, `wallet-receipt-${suffix}`);

    const prematureShipment = await request(`/api/vendor/orders/${secondVendorOrder.order_id}/shipment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: secondVendorCookie },
      body: JSON.stringify({ trackingReference: 'TRACK-TEST-1' })
    });
    assert.equal(prematureShipment.status, 409, 'Shipment details are locked until the order is packed.');
    for (const status of ['confirmed', 'packed']) {
      const update = await request(`/api/vendor/orders/${secondVendorOrder.order_id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: secondVendorCookie },
        body: JSON.stringify({ status })
      });
      assert.equal(update.status, 200);
    }
    const wrongVendorShipment = await request(`/api/vendor/orders/${secondVendorOrder.order_id}/shipment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: vendorCookie },
      body: JSON.stringify({ trackingReference: 'TRACK-TEST-1' })
    });
    assert.equal(wrongVendorShipment.status, 404);
    const shipmentDetails = {
      carrier: 'Test carrier', bookingReference: 'BOOK-TEST-1', trackingReference: 'TRACK-TEST-1',
      trackingUrl: 'https://carrier.example/track/TRACK-TEST-1', notes: 'Manual shipment fixture.'
    };
    const secondVendorRoute = await query('SELECT shipping_provider FROM orders WHERE order_id = $1', [secondVendorOrder.order_id]);
    if (secondVendorRoute.rows[0].shipping_provider === 'PMV') {
      Object.assign(shipmentDetails, {
        driverName: 'Test PMV Driver',
        driverPhone: secondVendorPhone,
        vehiclePlate: 'TEST 123',
        vehicleDescription: 'Test minibus'
      });
    }
    const shipmentUpdate = await request(`/api/vendor/orders/${secondVendorOrder.order_id}/shipment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: secondVendorCookie },
      body: JSON.stringify(shipmentDetails)
    });
    assert.equal(shipmentUpdate.status, 200);
    const lockedRouteEdit = await request(`/api/admin/orders/${secondVendorOrder.order_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ deliveryProvince: differentProvince(freightRoute.destination), shippingProvider: 'Ship' })
    });
    assert.equal(lockedRouteEdit.status, 409,
      'Admins cannot change shipping routes after fulfillment starts.');
    const buyerShipmentDetail = await request(`/api/orders/${secondVendorOrder.order_id}`, { headers: { Cookie: buyerCookie } });
    assert.equal(buyerShipmentDetail.status, 200);
    const buyerShipmentOrder = (await buyerShipmentDetail.json()).order;
    assert.equal(buyerShipmentOrder.shipment_tracking_reference, 'TRACK-TEST-1');
    const originalOrderTotal = Number(buyerShipmentOrder.total_kina);
    const buyerOrderEdit = await request(`/api/admin/orders/${secondVendorOrder.order_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ deliveryAddress: 'Unauthorized address change' })
    });
    assert.equal(buyerOrderEdit.status, 403);
    const adminOrderEdit = await request(`/api/admin/orders/${secondVendorOrder.order_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ deliveryAddress: 'Corrected test delivery address' })
    });
    assert.equal(adminOrderEdit.status, 200);
    const editedOrder = (await adminOrderEdit.json()).order;
    assert.equal(editedOrder.delivery_address, 'Corrected test delivery address');
    assert.equal(Number(editedOrder.total_kina), originalOrderTotal, 'Admin delivery edits cannot change financial totals.');

    const overRefund = await request(`/api/admin/orders/${secondVendorOrder.order_id}/refunds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ amountKina: originalOrderTotal + 0.01, refundMethod: 'bank_transfer', reason: 'Exceeds payment.' })
    });
    assert.equal(overRefund.status, 409);
    const partialRefundAmount = Math.round(originalOrderTotal * 50) / 100;
    const partialRefund = await request(`/api/admin/orders/${secondVendorOrder.order_id}/refunds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ amountKina: partialRefundAmount, refundMethod: 'bank_transfer', reference: `refund-part-${suffix}`, reason: 'Approved partial manual refund.' })
    });
    assert.equal(partialRefund.status, 201);
    assert.equal((await partialRefund.json()).paymentStatus, 'successful');
    const fullRefundAmount = Math.round((originalOrderTotal - partialRefundAmount) * 100) / 100;
    const fullRefund = await request(`/api/admin/orders/${secondVendorOrder.order_id}/refunds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ amountKina: fullRefundAmount, refundMethod: 'mobile_wallet', reason: 'Complete remaining manual refund.' })
    });
    assert.equal(fullRefund.status, 201);
    assert.equal((await fullRefund.json()).paymentStatus, 'refunded');
    const buyerRefundedOrder = await request(`/api/orders/${secondVendorOrder.order_id}`, { headers: { Cookie: buyerCookie } });
    const refundedOrderBody = (await buyerRefundedOrder.json()).order;
    assert.equal(refundedOrderBody.payment_status, 'refunded');
    assert.equal(Number(refundedOrderBody.refunded_kina), originalOrderTotal);

    const codCart = await request(`/api/cart/items/${secondProduct.product_id}`, {
      method: 'POST', headers: { Cookie: secondBuyerCookie }
    });
    assert.equal(codCart.status, 200);
    const codKey = crypto.randomUUID();
    const codCheckout = await postJson('/api/checkout', {
      deliveryAddress: 'Test address for cash on delivery',
      deliveryProvince: freightRoute.destination,
      phoneNumber: secondBuyerPhone,
      shippingProvider: freightRoute.provider,
      vendorPaymentMethods: [{ vendorId: String(secondVendorId), methodId: 'cash_on_delivery' }]
    }, secondBuyerCookie, { 'Idempotency-Key': codKey });
    assert.equal(codCheckout.status, 201);
    const codOrder = (await codCheckout.json()).orders[0];
    const prematureCodReceipt = await postJson(`/api/vendor/orders/${codOrder.order_id}/payment-confirmation`, {}, secondVendorCookie);
    assert.equal(prematureCodReceipt.status, 409, 'Cash on delivery cannot be marked received before delivery.');
    for (const status of ['confirmed', 'packed']) {
      const update = await request(`/api/vendor/orders/${codOrder.order_id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: secondVendorCookie },
        body: JSON.stringify({ status })
      });
      assert.equal(update.status, 200, `COD fulfillment advances to ${status}`);
    }
    const codShipment = await request(`/api/vendor/orders/${codOrder.order_id}/shipment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: secondVendorCookie },
      body: JSON.stringify({
        driverName: 'Test COD Driver',
        driverPhone: secondVendorPhone,
        vehiclePlate: 'COD 123',
        vehicleDescription: 'Test delivery vehicle'
      })
    });
    assert.equal(codShipment.status, 200);
    for (const status of ['shipped', 'delivered']) {
      const update = await request(`/api/vendor/orders/${codOrder.order_id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: secondVendorCookie },
        body: JSON.stringify({ status })
      });
      assert.equal(update.status, 200, `COD fulfillment advances to ${status}`);
    }
    const dispatchedStock = await query(
      `SELECT p.stock_quantity, ir.status AS reservation_status, pay.expires_at
         FROM products p
         JOIN order_items i ON i.product_id = p.product_id AND i.order_id = $1
         JOIN inventory_reservations ir ON ir.order_id = i.order_id AND ir.product_id = i.product_id
         JOIN payments pay ON pay.order_id = i.order_id`,
      [codOrder.order_id]
    );
    assert.equal(dispatchedStock.rows[0].stock_quantity, 1);
    assert.equal(dispatchedStock.rows[0].reservation_status, 'consumed');
    assert.equal(dispatchedStock.rows[0].expires_at, null, 'Dispatched COD stock is consumed, not reserved indefinitely.');
    const codReceipt = await postJson(`/api/vendor/orders/${codOrder.order_id}/payment-confirmation`, {
      verificationReference: `cod-receipt-${suffix}`
    }, secondVendorCookie);
    assert.equal(codReceipt.status, 200, JSON.stringify(await codReceipt.clone().json()));
    const finalCodStock = await query('SELECT stock_quantity FROM products WHERE product_id = $1', [secondProduct.product_id]);
    assert.equal(finalCodStock.rows[0].stock_quantity, 1, 'Confirming collected COD does not decrement stock twice.');

    const history = await request('/api/orders', { headers: { Cookie: buyerCookie } });
    assert.equal(history.status, 200);
    assert.ok((await history.json()).orders.some(function (item) { return String(item.order_id) === String(order.order_id); }));
    const unauthorizedOrder = await request(`/api/orders/${order.order_id}`, { headers: { Cookie: vendorCookie } });
    assert.equal(unauthorizedOrder.status, 404);
    const otherBuyerOrder = await request(`/api/orders/${order.order_id}`, { headers: { Cookie: secondBuyerCookie } });
    assert.equal(otherBuyerOrder.status, 404);

    const dashboard = await request('/api/admin/dashboard', { headers: { Cookie: adminCookie } });
    assert.equal(dashboard.status, 200);
    const dashboardBody = await dashboard.json();
    assert.ok(dashboardBody.activity.length > 0);
    assert.ok(Number(dashboardBody.analytics.orders_last_30_days) >= 1);
    assert.ok(Number(dashboardBody.analytics.net_recorded_revenue_kina) >= 0);

    const pause = await request(`/api/admin/products/${product.product_id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'paused' })
    });
    assert.equal(pause.status, 200);
    const unavailable = await request(`/api/products/${product.product_id}`);
    assert.equal(unavailable.status, 404);

    const disabledRate = await postJson('/api/admin/freight-rates', {
      originProvince: freightRoute.origin,
      destinationProvince: freightRoute.destination,
      provider: freightRoute.provider,
      amountKina: 0.75,
      isEstimate: true,
      active: false
    }, adminCookie);
    assert.equal(disabledRate.status, 200);
    const disabledQuote = await postJson('/api/freight/estimate', {
      originProvinces: [freightRoute.origin],
      destinationProvince: freightRoute.destination,
      provider: freightRoute.provider
    }, buyerCookie);
    assert.equal(disabledQuote.status, 503);

    const rejection = await request(`/api/admin/vendors/${vendorId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'rejected' })
    });
    assert.equal(rejection.status, 200);
    assert.equal((await rejection.json()).vendor.status, 'rejected');

    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).schema, 'ready');
  } finally {
    const fixtureBuyerIds = [buyerId, secondBuyerId].filter(Boolean);
    if (fixtureBuyerIds.length) {
      const orders = await query('SELECT order_id FROM orders WHERE buyer_id = ANY($1::bigint[])', [fixtureBuyerIds]);
      for (const order of orders.rows) {
        await query('DELETE FROM order_refunds WHERE order_id = $1', [order.order_id]);
        await query('DELETE FROM payments WHERE order_id = $1', [order.order_id]);
        await query('DELETE FROM orders WHERE order_id = $1', [order.order_id]);
      }
    }
    if (freightRoute) {
      await query(
        'DELETE FROM freight_rates WHERE origin_province = $1 AND destination_province = $2 AND provider = $3',
        [freightRoute.origin, freightRoute.destination, freightRoute.provider]
      );
      if (crossFreightDestination) {
        await query(
          `DELETE FROM freight_rates WHERE origin_province = $1 AND destination_province = $2 AND provider = 'Ship'`,
          [freightRoute.origin, crossFreightDestination]
        );
      }
    }
    if (adminId) await query('DELETE FROM admin_audit_logs WHERE admin_user_id = $1', [adminId]);
    for (const imageUrl of uploadedImagePaths) {
      await fs.unlink(path.join(uploadsRoot, 'products', path.basename(imageUrl))).catch(function () {});
    }
    await query('DELETE FROM users WHERE email = ANY($1::text[])', [[adminEmail, vendorEmail, secondVendorEmail, buyerEmail]]);
    await new Promise(function (resolve, reject) {
      server.close(function (error) { if (error) reject(error); else resolve(); });
    });
    await pool.end();
  }
});
