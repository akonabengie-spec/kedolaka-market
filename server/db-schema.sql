-- Legacy MySQL schema retained for reference. Use postgres-schema.sql for this application.
CREATE TABLE users (
    user_id INT NOT NULL AUTO_INCREMENT,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone_number VARCHAR(30) NOT NULL,
    home_province VARCHAR(120) NOT NULL,
    role VARCHAR(20) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    UNIQUE (email),
    CHECK (role IN ('buyer', 'vendor'))
);

CREATE TABLE vendors (
    vendor_id INT NOT NULL AUTO_INCREMENT,
    user_id INT NOT NULL,
    business_name VARCHAR(180) NOT NULL,
    province VARCHAR(120) NOT NULL,
    settlement_method VARCHAR(50) NOT NULL,
    settlement_account VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vendor_id),
    CONSTRAINT fk_vendors_user
        FOREIGN KEY (user_id)
        REFERENCES users(user_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CHECK (status IN ('active', 'review', 'suspended'))
);

CREATE TABLE products (
    product_id INT NOT NULL AUTO_INCREMENT,
    vendor_id INT NOT NULL,
    product_name VARCHAR(180) NOT NULL,
    category VARCHAR(80) NOT NULL,
    province VARCHAR(120) NOT NULL,
    price_kina DECIMAL(12,2) NOT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    status VARCHAR(25) NOT NULL DEFAULT 'listed',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (product_id),
    CONSTRAINT fk_products_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(vendor_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CHECK (price_kina >= 0),
    CHECK (stock_quantity >= 0),
    CHECK (status IN ('listed', 'paused', 'out_of_stock'))
);

CREATE TABLE orders (
    order_id INT NOT NULL AUTO_INCREMENT,
    buyer_id INT NOT NULL,
    vendor_id INT NOT NULL,
    product_id INT NOT NULL,
    buyer_province VARCHAR(120) NOT NULL,
    seller_province VARCHAR(120) NOT NULL,
    subtotal_kina DECIMAL(12,2) NOT NULL,
    shipping_kina DECIMAL(12,2) NOT NULL,
    total_kina DECIMAL(12,2) NOT NULL,
    payment_method VARCHAR(30) NOT NULL,
    payment_status VARCHAR(25) NOT NULL DEFAULT 'pending',
    shipping_provider VARCHAR(40) NOT NULL,
    order_status VARCHAR(25) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (order_id),
    CONSTRAINT fk_orders_buyer
        FOREIGN KEY (buyer_id)
        REFERENCES users(user_id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,
    CONSTRAINT fk_orders_vendor
        FOREIGN KEY (vendor_id)
        REFERENCES vendors(vendor_id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,
    CONSTRAINT fk_orders_product
        FOREIGN KEY (product_id)
        REFERENCES products(product_id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,
    CHECK (subtotal_kina >= 0),
    CHECK (shipping_kina >= 0),
    CHECK (total_kina >= 0),
    CHECK (payment_method IN ('BSPPay', 'KinaBank', 'Cellmoni', 'MPaisa', 'PostPNG_COD', 'PMV_Cash')),
    CHECK (payment_status IN ('pending', 'authorized', 'paid', 'failed')),
    CHECK (order_status IN ('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'))
);
