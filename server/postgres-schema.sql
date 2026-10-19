BEGIN;

CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    phone_number VARCHAR(30) NOT NULL UNIQUE,
    home_province VARCHAR(120) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'vendor', 'admin')),
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expiry ON auth_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendors (
    vendor_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    business_name VARCHAR(180),
    province VARCHAR(120) NOT NULL,
    payment_methods JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'active', 'suspended', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);

CREATE TABLE IF NOT EXISTS products (
    product_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id BIGINT NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
    product_name VARCHAR(180) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category VARCHAR(80) NOT NULL,
    province VARCHAR(120) NOT NULL,
    delivery_type VARCHAR(20) NOT NULL DEFAULT 'both',
    item_condition VARCHAR(20) NOT NULL DEFAULT 'new',
    price_unit VARCHAR(40) NOT NULL DEFAULT 'item',
    delivery_notes VARCHAR(500) NOT NULL DEFAULT '',
    additional_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivery_contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
    price_kina NUMERIC(12,2) NOT NULL CHECK (price_kina > 0),
    stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    image_url TEXT,
    status VARCHAR(25) NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'paused', 'out_of_stock')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT products_delivery_type_check CHECK (delivery_type IN ('delivery', 'pickup', 'both')),
    CONSTRAINT products_item_condition_check CHECK (item_condition IN ('new', 'used', 'refurbished'))
);
CREATE INDEX IF NOT EXISTS idx_products_listed_category ON products(status, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor_id, status);

CREATE TABLE IF NOT EXISTS cart_items (
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS freight_rates (
    freight_rate_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    origin_province VARCHAR(120) NOT NULL,
    destination_province VARCHAR(120) NOT NULL,
    provider VARCHAR(40) NOT NULL CHECK (provider IN ('PMV', 'PostPNG', 'Ship', 'AirNiugini', 'Pickup')),
    amount_kina NUMERIC(12,2) NOT NULL CHECK (amount_kina >= 0),
    is_estimate BOOLEAN NOT NULL DEFAULT TRUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (origin_province, destination_province, provider)
);

CREATE TABLE IF NOT EXISTS orders (
    order_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    buyer_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    delivery_address VARCHAR(500) NOT NULL,
    delivery_province VARCHAR(120) NOT NULL,
    phone_number VARCHAR(30) NOT NULL,
    subtotal_kina NUMERIC(12,2) NOT NULL CHECK (subtotal_kina >= 0),
    shipping_kina NUMERIC(12,2) NOT NULL CHECK (shipping_kina >= 0),
    total_kina NUMERIC(12,2) NOT NULL CHECK (total_kina >= 0),
    shipping_provider VARCHAR(40) NOT NULL CHECK (shipping_provider IN ('PMV', 'PostPNG', 'Ship', 'AirNiugini', 'Pickup')),
    shipping_payer VARCHAR(10) NOT NULL DEFAULT 'buyer' CHECK (shipping_payer IN ('buyer', 'vendor')),
    payment_method VARCHAR(40) NOT NULL CHECK (payment_method IN (
        'Sandbox', 'PostPNG_COD', 'PMV_Cash', 'sandbox_test_record',
        'manual_bank_transfer', 'mobile_wallet', 'cash_on_delivery', 'in_person'
    )),
    checkout_group_key UUID,
    payment_instructions TEXT,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'successful', 'failed', 'refunded', 'cancelled', 'expired')),
    order_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (order_status IN ('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled')),
    payment_reference_phone VARCHAR(30),
    payment_reference_whatsapp VARCHAR(30),
    freight_is_estimate BOOLEAN NOT NULL DEFAULT TRUE,
    shipment_carrier VARCHAR(80),
    shipment_booking_reference VARCHAR(120),
    shipment_tracking_reference VARCHAR(120),
    shipment_tracking_url TEXT,
    shipment_notes VARCHAR(500),
    shipment_driver_name VARCHAR(120),
    shipment_driver_phone VARCHAR(30),
    shipment_vehicle_plate VARCHAR(20),
    shipment_vehicle_description VARCHAR(120),
    shipment_updated_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
    shipment_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_created ON orders(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(order_status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
    order_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
    vendor_id BIGINT NOT NULL REFERENCES vendors(vendor_id) ON DELETE RESTRICT,
    product_name VARCHAR(180) NOT NULL,
    seller_province VARCHAR(120) NOT NULL,
    unit_price_kina NUMERIC(12,2) NOT NULL CHECK (unit_price_kina >= 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    delivery_contact JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_vendor ON order_items(vendor_id, order_id);

CREATE TABLE IF NOT EXISTS vendor_order_fulfillments (
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    vendor_id BIGINT NOT NULL REFERENCES vendors(vendor_id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'packed', 'shipped', 'delivered')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (order_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_fulfillments_vendor ON vendor_order_fulfillments(vendor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS payments (
    payment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE RESTRICT,
    provider VARCHAR(40) NOT NULL,
    mode VARCHAR(20) NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('sandbox', 'live', 'manual')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'successful', 'failed', 'refunded', 'cancelled', 'expired')),
    transaction_reference VARCHAR(120) NOT NULL UNIQUE,
    provider_reference VARCHAR(120),
    verified_by BIGINT REFERENCES users(user_id) ON DELETE RESTRICT,
    verified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    amount_kina NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_kina >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS order_refunds (
    refund_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
    payment_id BIGINT NOT NULL REFERENCES payments(payment_id) ON DELETE RESTRICT,
    admin_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    amount_kina NUMERIC(12,2) NOT NULL CHECK (amount_kina > 0),
    refund_method VARCHAR(30) NOT NULL CHECK (refund_method IN ('bank_transfer', 'mobile_wallet', 'cash', 'other')),
    reference VARCHAR(120),
    reason VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_refunds_order_created
    ON order_refunds(order_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference
    ON payments(provider, provider_reference)
    WHERE provider_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_expiry
    ON payments(expires_at)
    WHERE status = 'pending' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_reservations (
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'consumed', 'released', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active_product
    ON inventory_reservations(product_id, expires_at)
    WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_orders_buyer_checkout_group
    ON orders (buyer_id, checkout_group_key)
    WHERE checkout_group_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS vendor_payment_verifications (
    verification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    vendor_id BIGINT NOT NULL REFERENCES vendors(vendor_id) ON DELETE RESTRICT,
    verified_by BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL CHECK (status IN ('successful', 'failed')),
    receipt_reference VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_payment_verifications_order
    ON vendor_payment_verifications(order_id, created_at DESC);

COMMIT;