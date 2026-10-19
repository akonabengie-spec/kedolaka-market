'use strict';

function notConfiguredAdapter(name) {
  const unavailable = async function () {
    const error = new Error(`${name} payment integration is NOT CONFIGURED.`);
    error.code = 'payment_provider_not_configured';
    throw error;
  };
  return Object.freeze({
    status: 'NOT CONFIGURED',
    createPayment: unavailable,
    verifyCallback: unavailable,
    verifyPayment: unavailable
  });
}

const GATEWAY_ADAPTERS = Object.freeze({
  bsp_pay: notConfiguredAdapter('BSP Pay'),
  kina_bank_ipg: notConfiguredAdapter('Kina Bank IPG'),
  digicel_financial_services: notConfiguredAdapter('Digicel Financial Services'),
  digitec_png_financial_services: notConfiguredAdapter('Digitec PNG Financial Services'),
  omega_paymybills: notConfiguredAdapter('Omega PayMyBills')
});

const GATEWAY_ENABLE_FLAGS = [
  'PAYMENT_BSP_PAY_ENABLED',
  'PAYMENT_KINA_BANK_IPG_ENABLED',
  'PAYMENT_DIGICEL_FINANCIAL_SERVICES_ENABLED',
  'PAYMENT_DIGITEC_PNG_FINANCIAL_SERVICES_ENABLED',
  'PAYMENT_OMEGA_PAYMYBILLS_ENABLED'
];

const MANUAL_METHODS = [
  {
    id: 'manual_bank_transfer',
    name: 'Manual bank transfer',
    enabled: 'PAYMENT_MANUAL_BANK_TRANSFER_ENABLED',
    instructions: 'PAYMENT_MANUAL_BANK_TRANSFER_INSTRUCTIONS'
  },
  {
    id: 'cash_on_delivery',
    name: 'Cash on delivery',
    enabled: 'PAYMENT_CASH_ON_DELIVERY_ENABLED',
    instructions: 'PAYMENT_CASH_ON_DELIVERY_INSTRUCTIONS'
  },
  {
    id: 'in_person',
    name: 'In-person payment',
    enabled: 'PAYMENT_IN_PERSON_ENABLED',
    instructions: 'PAYMENT_IN_PERSON_INSTRUCTIONS'
  }
];

function positiveInteger(value, fallback, name, minimum, maximum) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function enabled(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Payment enablement settings must be either true or false.');
}

function getPaymentConfiguration(env) {
  const config = env || process.env;
  const production = config.NODE_ENV === 'production';
  const sandboxEnabled = enabled(config.PAYMENT_SANDBOX_ENABLED);
  for (const flag of GATEWAY_ENABLE_FLAGS) {
    if (enabled(config[flag])) {
      throw new Error(`${flag} cannot be enabled because its payment provider is NOT CONFIGURED.`);
    }
  }
  if (production && sandboxEnabled) {
    throw new Error('PAYMENT_SANDBOX_ENABLED cannot be true in production.');
  }
  const onlineMinutes = positiveInteger(config.PAYMENT_RESERVATION_MINUTES, 30, 'PAYMENT_RESERVATION_MINUTES', 5, 1440);
  const manualMinutes = positiveInteger(config.PAYMENT_MANUAL_RESERVATION_MINUTES, 1440, 'PAYMENT_MANUAL_RESERVATION_MINUTES', 5, 10080);
  const methods = [];

  if (sandboxEnabled && !production) {
    methods.push({
      id: 'sandbox_test_record',
      name: 'Sandbox test order',
      description: 'Test-only order record. No money is charged or verified.',
      mode: 'sandbox',
      databaseMethod: 'Sandbox',
      reservationMinutes: onlineMinutes,
      instructions: ''
    });
  }

  for (const method of MANUAL_METHODS) {
    if (!enabled(config[method.enabled])) continue;
    const instructions = typeof config[method.instructions] === 'string' ? config[method.instructions].trim() : '';
    if (instructions.length < 5 || instructions.length > 1000) {
      throw new Error(`${method.instructions} must contain 5 to 1000 characters when the method is enabled.`);
    }
    methods.push({
      id: method.id,
      name: method.name,
      description: 'Manual payment. An administrator must verify receipt before payment is marked successful.',
      mode: 'manual',
      databaseMethod: method.id,
      reservationMinutes: manualMinutes,
      instructions
    });
  }

  return { methods, gateways: GATEWAY_ADAPTERS };
}

function validatePaymentConfiguration(env) {
  getPaymentConfiguration(env);
}

module.exports = { GATEWAY_ADAPTERS, getPaymentConfiguration, validatePaymentConfiguration };
