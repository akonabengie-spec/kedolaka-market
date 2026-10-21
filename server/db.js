const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const sslCaPath = process.env.PGSSL_CA_CERT_PATH
  ? path.resolve(process.env.PGSSL_CA_CERT_PATH)
  : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSLMODE === 'require'
    ? {
      rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false',
      ...(sslCaPath ? { ca: fs.readFileSync(sslCaPath, 'utf8') } : {})
    }
    : undefined
});

pool.on('error', function (error) {
  console.error('Unexpected idle PostgreSQL client error:', error.code || 'database_error');
});

function query(text, values) {
  return pool.query(text, values);
}

async function checkDatabase() {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    console.error('PostgreSQL health check failed:', error.code || 'database_error');
    return { ok: false };
  }
}

async function checkSchema() {
  const requiredColumns = {
    users: ['user_id', 'full_name', 'email', 'phone_number', 'home_province', 'role', 'password_hash', 'updated_at'],
    auth_sessions: ['session_id', 'user_id', 'expires_at', 'revoked_at'],
    password_reset_tokens: ['user_id', 'token_hash', 'expires_at'],
    vendors: ['vendor_id', 'user_id', 'business_name', 'province', 'payment_methods', 'status', 'updated_at'],
    products: ['product_id', 'vendor_id', 'product_name', 'description', 'category', 'province', 'delivery_type', 'item_condition', 'price_unit', 'delivery_notes', 'additional_details', 'delivery_contacts', 'price_kina', 'stock_quantity', 'image_url', 'status', 'created_at', 'updated_at'],
    cart_items: ['user_id', 'product_id', 'quantity', 'created_at', 'updated_at'],
    freight_rates: ['origin_province', 'destination_province', 'provider', 'amount_kina', 'is_estimate', 'active'],
    orders: ['order_id', 'buyer_id', 'delivery_address', 'delivery_province', 'phone_number', 'subtotal_kina', 'shipping_kina', 'total_kina', 'shipping_provider', 'shipping_payer', 'payment_method', 'payment_status', 'order_status', 'payment_reference_phone', 'payment_reference_whatsapp', 'freight_is_estimate', 'shipment_carrier', 'shipment_booking_reference', 'shipment_tracking_reference', 'shipment_tracking_url', 'shipment_notes', 'shipment_driver_name', 'shipment_driver_phone', 'shipment_vehicle_plate', 'shipment_vehicle_description', 'shipment_updated_by', 'shipment_updated_at', 'checkout_group_key', 'created_at', 'updated_at'],
    order_items: ['order_item_id', 'order_id', 'product_id', 'vendor_id', 'product_name', 'seller_province', 'unit_price_kina', 'quantity', 'delivery_contact'],
    vendor_order_fulfillments: ['order_id', 'vendor_id', 'status', 'updated_at'],
    payments: ['payment_id', 'order_id', 'provider', 'mode', 'status', 'transaction_reference', 'provider_reference', 'verified_by', 'verified_at', 'expires_at', 'amount_kina'],
    inventory_reservations: ['order_id', 'product_id', 'quantity', 'status', 'expires_at', 'created_at', 'updated_at'],
    vendor_payment_verifications: ['verification_id', 'order_id', 'vendor_id', 'verified_by', 'status', 'receipt_reference', 'created_at'],
    order_refunds: ['refund_id', 'order_id', 'payment_id', 'admin_user_id', 'amount_kina', 'refund_method', 'reference', 'reason', 'created_at'],
    admin_audit_logs: ['audit_log_id', 'admin_user_id', 'action', 'resource_type', 'resource_id', 'details', 'created_at'],
    schema_migrations: ['version', 'applied_at']
  };
  requiredColumns.orders.push('idempotency_key', 'checkout_fingerprint', 'checkout_group_key', 'payment_instructions');
  const requiredTables = Object.keys(requiredColumns);
  const requiredConstraints = [
    'users_email_key', 'users_phone_number_key', 'users_role_check',
    'auth_sessions_user_id_fkey', 'vendors_user_id_key', 'vendors_status_check',
    'products_vendor_id_fkey', 'products_price_kina_check', 'products_stock_quantity_check', 'products_delivery_type_check', 'products_item_condition_check',
    'products_status_check', 'cart_items_user_id_fkey', 'cart_items_product_id_fkey',
    'cart_items_quantity_check', 'freight_rates_origin_province_destination_province_provider_key',
    'freight_rates_provider_check', 'freight_rates_amount_kina_check', 'orders_buyer_id_fkey',
    'orders_shipping_provider_check', 'orders_shipping_payer_check', 'orders_payment_method_check', 'orders_payment_status_check', 'orders_order_status_check', 'order_items_order_id_fkey',
    'order_items_product_id_fkey', 'order_items_vendor_id_fkey',
    'vendor_order_fulfillments_vendor_id_fkey', 'payments_order_id_fkey',
    'payments_status_check', 'payments_mode_check', 'payments_verified_by_fkey',
    'inventory_reservations_order_id_fkey', 'inventory_reservations_product_id_fkey',
    'inventory_reservations_quantity_check', 'inventory_reservations_status_check',
    'vendor_payment_verifications_order_id_fkey', 'vendor_payment_verifications_vendor_id_fkey',
    'vendor_payment_verifications_verified_by_fkey', 'vendor_payment_verifications_status_check',
    'order_refunds_order_id_fkey', 'order_refunds_payment_id_fkey', 'order_refunds_admin_user_id_fkey',
    'order_refunds_amount_kina_check', 'order_refunds_refund_method_check',
    'admin_audit_logs_admin_user_id_fkey'
  ];
  const requiredIndexes = [
    'idx_auth_sessions_user_expiry', 'idx_vendors_status', 'idx_products_listed_category',
    'idx_products_vendor', 'idx_orders_buyer_created', 'idx_orders_status_created',
    'idx_order_items_order', 'idx_order_items_vendor', 'idx_vendor_fulfillments_vendor',
    'idx_orders_buyer_idempotency', 'idx_admin_audit_logs_created', 'idx_admin_audit_logs_resource',
    'idx_payments_provider_reference', 'idx_payments_expiry', 'idx_inventory_reservations_active_product',
    'idx_orders_buyer_checkout_group', 'idx_vendor_payment_verifications_order', 'idx_order_refunds_order_created'
  ];
  try {
    const [columnsResult, constraintsResult, indexesResult] = await Promise.all([
      pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [requiredTables]
      ),
      pool.query(
        `SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
        []
      ),
      pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
        []
      )
    ]);
    const existing = new Set(columnsResult.rows.map(function (row) { return `${row.table_name}.${row.column_name}`; }));
    const missing = [];
    for (const table of requiredTables) {
      for (const column of requiredColumns[table]) {
        if (!existing.has(`${table}.${column}`)) missing.push(`${table}.${column}`);
      }
    }
    const constraints = new Set(constraintsResult.rows.map(function (row) { return row.conname; }));
    for (const constraint of requiredConstraints) {
      if (!constraints.has(constraint)) missing.push(`constraint:${constraint}`);
    }
    const indexes = new Set(indexesResult.rows.map(function (row) { return row.indexname; }));
    for (const index of requiredIndexes) {
      if (!indexes.has(index)) missing.push(`index:${index}`);
    }
    return { ok: missing.length === 0, missing };
  } catch (error) {
    console.error('PostgreSQL schema check failed:', error.code || 'database_error');
    return { ok: false, missing: requiredTables.map(function (table) { return `${table}.*`; }) };
  }
}

module.exports = { pool, query, checkDatabase, checkSchema };