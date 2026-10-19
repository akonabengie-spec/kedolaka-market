'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GATEWAY_ADAPTERS, getPaymentConfiguration } = require('../server/payments');

test('online gateways remain unavailable until their provider integration exists', async function () {
  for (const [name, adapter] of Object.entries(GATEWAY_ADAPTERS)) {
    assert.equal(adapter.status, 'NOT CONFIGURED', name);
    await assert.rejects(adapter.createPayment(), /NOT CONFIGURED/, name);
    await assert.rejects(adapter.verifyCallback(), /NOT CONFIGURED/, name);
    await assert.rejects(adapter.verifyPayment(), /NOT CONFIGURED/, name);
  }
  assert.deepEqual(getPaymentConfiguration({ NODE_ENV: 'production' }).methods, []);
});

test('sandbox is test-only and never claims verified payment', function () {
  const config = getPaymentConfiguration({
    NODE_ENV: 'test',
    PAYMENT_SANDBOX_ENABLED: 'true'
  });
  assert.deepEqual(config.methods.map(function (method) { return method.id; }), ['sandbox_test_record']);
  assert.equal(config.methods[0].mode, 'sandbox');
  assert.match(config.methods[0].description, /No money is charged or verified/);
  assert.throws(function () {
    getPaymentConfiguration({ NODE_ENV: 'production', PAYMENT_SANDBOX_ENABLED: 'true' });
  }, /cannot be true in production/);
});

test('manual payment methods are shown only with explicit instructions', function () {
  const methods = getPaymentConfiguration({
    NODE_ENV: 'production',
    PAYMENT_MANUAL_BANK_TRANSFER_ENABLED: 'true',
    PAYMENT_MANUAL_BANK_TRANSFER_INSTRUCTIONS: 'Transfer using merchant details supplied after checkout.'
  }).methods;
  assert.deepEqual(methods.map(function (method) { return method.id; }), ['manual_bank_transfer']);
  assert.equal(methods[0].mode, 'manual');
  assert.equal(methods[0].instructions, 'Transfer using merchant details supplied after checkout.');
  assert.throws(function () {
    getPaymentConfiguration({ PAYMENT_CASH_ON_DELIVERY_ENABLED: 'true' });
  }, /PAYMENT_CASH_ON_DELIVERY_INSTRUCTIONS/);
});

test('unconfigured online providers cannot be enabled through environment settings', function () {
  for (const flag of [
    'PAYMENT_BSP_PAY_ENABLED',
    'PAYMENT_KINA_BANK_IPG_ENABLED',
    'PAYMENT_DIGICEL_FINANCIAL_SERVICES_ENABLED',
    'PAYMENT_DIGITEC_PNG_FINANCIAL_SERVICES_ENABLED',
    'PAYMENT_OMEGA_PAYMYBILLS_ENABLED'
  ]) {
    assert.throws(function () {
      getPaymentConfiguration({ [flag]: 'true' });
    }, /NOT CONFIGURED/, flag);
  }
});
