CREATE TABLE `accounts` (
  `account_id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(100) DEFAULT NULL,
  `name` varchar(255) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `financial_number` varchar(100) DEFAULT NULL,
  `user_id` INT DEFAULT NULL,
  `is_customer` tinyint(1) DEFAULT 0,
  `is_supplier` tinyint(1) DEFAULT 0,
  `is_bank` tinyint(1) DEFAULT 0,
  `is_employee` tinyint(1) DEFAULT 0,
  `is_deleted` tinyint(1) DEFAULT 0,
  PRIMARY KEY (`account_id`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `journal_vouchers` (
  `journal_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `journal_number` varchar(50) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `journal_date` datetime NOT NULL,
  `reference_number` varchar(50) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `journal_description` varchar(255) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `total_value` decimal(10,2) NOT NULL,
  `exchange_value` decimal(10,2) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`journal_id`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE `journal_items` (
  `journal_item_id` int NOT NULL AUTO_INCREMENT,
  `journal_id_fk` int NOT NULL,
  `journal_date` datetime DEFAULT NULL,
  `account_id_fk` int NOT NULL,
  `partner_id_fk` int DEFAULT NULL,
  `reference_number` varchar(50) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `debit` decimal(10,2) NOT NULL DEFAULT '0.00',
  `debit_lbp` decimal(20,2) DEFAULT '0.00',
  `credit` decimal(10,2) NOT NULL DEFAULT '0.00',
  `credit_lbp` decimal(20,2) DEFAULT '0.00',
  `currency` varchar(4) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `exchange_value` decimal(10,2) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`journal_item_id`)
) ENGINE=InnoDB AUTO_INCREMENT=135 DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE karizma.products (
	product_id INT auto_increment NOT NULL,
	category_id_fk INT NULL,
	brand_id_fk INT NULL,
	sku varchar(100) NULL,
	barcode varchar(255) NULL,
	product_name varchar(255) NOT NULL,
	cost_usd DECIMAL(10,2) NOT NULL,
	avg_cost_usd decimal(10,2) NULL,
	unit_price_usd DECIMAL(10,2) NULL,
	whole_price_usd DECIMAL(10,2) NULL,
	grandwhole_price_usd DECIMAL(10,2) NULL,
	product_notes varchar(255) NULL,
	low_stock_threshold INT NULL,
	is_deleted TINYINT(1) DEFAULT 0 NULL,
	CONSTRAINT products_pk PRIMARY KEY (product_id)
)
ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_0900_ai_ci;