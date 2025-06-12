/*
 Navicat MySQL Data Transfer

 Source Server         : local
 Source Server Type    : MySQL
 Source Server Version : 80012
 Source Host           : localhost:3306
 Source Schema         : karizma-new

 Target Server Type    : MySQL
 Target Server Version : 80012
 File Encoding         : 65001

 Date: 11/06/2025 11:52:48
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for accounts
-- ----------------------------
DROP TABLE IF EXISTS `accounts`;
CREATE TABLE `accounts` (
  `account_id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `financial_number` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `is_customer` tinyint(1) DEFAULT '0',
  `is_supplier` tinyint(1) DEFAULT '0',
  `is_bank` tinyint(1) DEFAULT '0',
  `is_employee` tinyint(1) DEFAULT '0',
  `is_deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`account_id`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Records of accounts
-- ----------------------------
BEGIN;
INSERT INTO `accounts` VALUES (1, NULL, 'Ra3i', '', '', '', 20, 1, 0, 0, 0, 0);
INSERT INTO `accounts` VALUES (2, NULL, 'Shhab', NULL, '71992232', NULL, 20, 1, 0, 0, 0, 0);
INSERT INTO `accounts` VALUES (3, NULL, 'user customer', '', '', '', 19, 1, 0, 0, 0, 0);
INSERT INTO `accounts` VALUES (4, NULL, 'local customer', '', '', '', 19, 1, 0, 0, 0, 0);
INSERT INTO `accounts` VALUES (5, NULL, 'supplier1', 'asaas', '123', 'asas', NULL, 0, 1, 0, 0, 0);
INSERT INTO `accounts` VALUES (6, NULL, 'test', '', '', '', NULL, 0, 1, 0, 0, 0);
INSERT INTO `accounts` VALUES (7, NULL, 'qwqwqw', '', '', '', 17, 1, 0, 0, 0, 0);
COMMIT;

-- ----------------------------
-- Table structure for chart_of_accounts
-- ----------------------------
DROP TABLE IF EXISTS `chart_of_accounts`;
CREATE TABLE `chart_of_accounts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `account_number` varchar(10) NOT NULL,
  `english_name` varchar(100) NOT NULL,
  `french_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `arabic_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `category_number` int(11) NOT NULL,
  `sub_category_number` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `account_type` enum('EXPENSES','INCOME','EQUITY','ASSETS','LIABILITIES','ASSETS/ LIABILITIES') DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `chart_of_accounts_categories_unique` (`account_number`)
) ENGINE=InnoDB AUTO_INCREMENT=270 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Records of chart_of_accounts
-- ----------------------------
BEGIN;
INSERT INTO `chart_of_accounts` VALUES (1, '4011', 'Invoices ', 'Factures ', 'فواتیر ', 4, '40', 'LIABILITIES');
INSERT INTO `chart_of_accounts` VALUES (2, '4111', 'Ordinary Clients ', 'Clients Ordinaires ', 'زبائن عادیون ', 4, '41', 'ASSETS');
INSERT INTO `chart_of_accounts` VALUES (3, '413', 'Notes Receivable ( Clients ) ', 'Effets A Recevoir-Clients ', 'اوراق قبض - زبائن ', 4, '41', 'ASSETS');
INSERT INTO `chart_of_accounts` VALUES (4, '6011', 'Goods ', 'Marchandises ', 'البضاعة ', 6, '60', 'EXPENSES');
INSERT INTO `chart_of_accounts` VALUES (5, '7011', 'Sales Goods ', '- ', '- ', 7, '70', 'INCOME');
INSERT INTO `chart_of_accounts` VALUES (6, '44271', 'V.A.T On Sales', NULL, NULL, 4, '44', 'LIABILITIES');
INSERT INTO `chart_of_accounts` VALUES (7, '531', 'Cash Dollar', NULL, 'كاش دولار', 5, '53', 'ASSETS');
INSERT INTO `chart_of_accounts` VALUES (141, '401', 'Accounts Payables ( Suppliers ) ', 'Fournisseurs D\'Exploitation ', 'ذمم دائنة ) موردو الاستثمار ( ', 4, '40', 'LIABILITIES');
INSERT INTO `chart_of_accounts` VALUES (264, '6112', 'Consumables Purchases ', 'Achats De Matieres Et Fourn.Consommables ', 'شراء مواد ولوازم استھلاكیة ', 6, '61', 'EXPENSES');
INSERT INTO `chart_of_accounts` VALUES (265, '61121', 'Fuel And Gaz ', 'Combustibles ', 'محروقات ', 6, '61', 'EXPENSES');
INSERT INTO `chart_of_accounts` VALUES (266, '61122', 'Maintenance Products ', 'Produits D\'Entretien ', 'مواد الصیانة ', 6, '61', 'EXPENSES');
INSERT INTO `chart_of_accounts` VALUES (267, '61123', 'Workshop And Factory Supplies ', 'Fournitures D\'Atelier Et D\'Usine ', 'لوازم للمشغل و المصنع ', 6, '61', 'EXPENSES');
INSERT INTO `chart_of_accounts` VALUES (268, '61124', 'Stores Supplies ', 'Fournitures De Magasin ', 'لوازم للمخزن ', 6, '61', 'EXPENSES');
INSERT INTO `chart_of_accounts` VALUES (269, '61125', 'Office Supplies ', 'Fournitures De Bureau ', 'لوازم مكتبیة ', 6, '61', 'EXPENSES');
COMMIT;

-- ----------------------------
-- Table structure for deliver_order_items
-- ----------------------------
DROP TABLE IF EXISTS `deliver_order_items`;
CREATE TABLE `deliver_order_items` (
  `record_id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id_fk` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `quantity` int(11) NOT NULL,
  `unit_price` decimal(10,2) NOT NULL,
  `is_deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`record_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Table structure for deliver_orders
-- ----------------------------
DROP TABLE IF EXISTS `deliver_orders`;
CREATE TABLE `deliver_orders` (
  `order_id` int(11) NOT NULL AUTO_INCREMENT,
  `invoice_number` varchar(255) DEFAULT NULL,
  `order_datetime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `total_price` decimal(10,2) NOT NULL,
  `user_id_fk` int(11) NOT NULL,
  `admin_id_fk` int(11) NOT NULL,
  `notes` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `is_approved` tinyint(1) NOT NULL DEFAULT '0',
  `is_deleted` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Table structure for dispose_products
-- ----------------------------
DROP TABLE IF EXISTS `dispose_products`;
CREATE TABLE `dispose_products` (
  `dispose_id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `invoice_number` varchar(100) CHARACTER SET utf8 COLLATE utf8_general_ci NOT NULL,
  `products_number` int(11) NOT NULL,
  `total_count` int(11) NOT NULL,
  `total_cost` decimal(10,2) NOT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  `dispose_datetime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`dispose_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Table structure for dispose_products_items
-- ----------------------------
DROP TABLE IF EXISTS `dispose_products_items`;
CREATE TABLE `dispose_products_items` (
  `dispose_item_id` int(11) NOT NULL AUTO_INCREMENT,
  `dispose_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `quantity` int(11) NOT NULL,
  `unit_cost` decimal(10,2) NOT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`dispose_item_id`),
  KEY `dispose_id_fk` (`dispose_id`),
  KEY `product_id_fk` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Table structure for inventory
-- ----------------------------
DROP TABLE IF EXISTS `inventory`;
CREATE TABLE `inventory` (
  `record_id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id_fk` int(11) NOT NULL,
  `user_id_fk` int(11) NOT NULL,
  `grandwhole_price_usd` decimal(10,2) NOT NULL,
  `whole_price_usd` decimal(10,2) NOT NULL,
  `unit_price_usd` decimal(10,2) NOT NULL,
  `is_deleted` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`record_id`),
  KEY `inventory_product_id_fk_IDX` (`product_id_fk`) USING BTREE,
  KEY `inventory_user_id_fk_IDX` (`user_id_fk`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Table structure for inventory_transactions
-- ----------------------------
DROP TABLE IF EXISTS `inventory_transactions`;
CREATE TABLE `inventory_transactions` (
  `transaction_id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id_fk` int(11) NOT NULL,
  `user_id_fk` int(11) NOT NULL,
  `transaction_datetime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `transaction_type` enum('SALE','SUPPLY','RETURN','DELETE','DISPOSE','DELIVER','REVERSERETURN','REVERSEDISPOSE','REVERSEDELIVER') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `quantity` int(11) NOT NULL,
  PRIMARY KEY (`transaction_id`),
  KEY `inventory_transactions_product_id_fk_IDX` (`product_id_fk`) USING BTREE,
  KEY `inventory_transactions_transaction_type_IDX` (`transaction_type`) USING BTREE,
  KEY `inventory_transactions_user_id_fk_IDX` (`user_id_fk`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Table structure for journal_items
-- ----------------------------
DROP TABLE IF EXISTS `journal_items`;
CREATE TABLE `journal_items` (
  `journal_item_id` int(11) NOT NULL AUTO_INCREMENT,
  `journal_id_fk` int(11) NOT NULL,
  `journal_date` datetime DEFAULT NULL,
  `account_id_fk` int(11) NOT NULL,
  `user_id` int(11) DEFAULT NULL,
  `partner_id_fk` int(11) DEFAULT NULL,
  `reference_number` varchar(50) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `debit` decimal(10,2) NOT NULL DEFAULT '0.00',
  `debit_lbp` decimal(20,2) DEFAULT '0.00',
  `credit` decimal(10,2) NOT NULL DEFAULT '0.00',
  `credit_lbp` decimal(20,2) DEFAULT '0.00',
  `currency` varchar(4) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `exchange_value` decimal(10,2) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`journal_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- ----------------------------
-- Table structure for journal_vouchers
-- ----------------------------
DROP TABLE IF EXISTS `journal_vouchers`;
CREATE TABLE `journal_vouchers` (
  `journal_id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) DEFAULT NULL,
  `journal_number` varchar(50) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `journal_date` datetime NOT NULL,
  `reference_number` varchar(50) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `journal_description` varchar(255) CHARACTER SET utf8 COLLATE utf8_unicode_ci DEFAULT NULL,
  `total_value` decimal(10,2) NOT NULL,
  `exchange_value` decimal(10,2) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`journal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- ----------------------------
-- Table structure for products
-- ----------------------------
DROP TABLE IF EXISTS `products`;
CREATE TABLE `products` (
  `product_id` int(11) NOT NULL AUTO_INCREMENT,
  `category_id_fk` int(11) DEFAULT NULL,
  `brand_id_fk` int(11) DEFAULT NULL,
  `sku` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `product_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `avg_cost_usd` decimal(10,2) DEFAULT NULL,
  `unit_cost_usd` decimal(10,2) NOT NULL,
  `product_notes` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `low_stock_threshold` int(11) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Table structure for products_brands
-- ----------------------------
DROP TABLE IF EXISTS `products_brands`;
CREATE TABLE `products_brands` (
  `brand_id` int(11) NOT NULL AUTO_INCREMENT,
  `brand_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_deleted` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`brand_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Table structure for products_categories
-- ----------------------------
DROP TABLE IF EXISTS `products_categories`;
CREATE TABLE `products_categories` (
  `category_id` int(11) NOT NULL AUTO_INCREMENT,
  `category_index` int(11) DEFAULT NULL,
  `category_name` varchar(50) NOT NULL,
  `show_on_sell` tinyint(1) NOT NULL DEFAULT '1',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`category_id`)
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8;

-- ----------------------------
-- Table structure for return_order_items
-- ----------------------------
DROP TABLE IF EXISTS `return_order_items`;
CREATE TABLE `return_order_items` (
  `order_item_id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `quantity` int(11) NOT NULL,
  `unit_price` decimal(10,2) NOT NULL,
  `total_price` decimal(10,2) NOT NULL,
  `unit_cost` decimal(10,2) NOT NULL,
  `price_type` enum('unit_price_usd','whole_price_usd','grandwhole_price_usd','latest') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`order_item_id`),
  KEY `return_order_items_order_id` (`order_id`),
  KEY `return_order_items_product_id` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Table structure for return_orders
-- ----------------------------
DROP TABLE IF EXISTS `return_orders`;
CREATE TABLE `return_orders` (
  `order_id` int(11) NOT NULL AUTO_INCREMENT,
  `invoice_number` varchar(100) CHARACTER SET utf8 COLLATE utf8_general_ci NOT NULL,
  `journal_voucher_id` int(11) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `order_datetime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `total_amount` decimal(10,2) NOT NULL,
  `total_cost` decimal(10,2) NOT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`order_id`),
  KEY `return_customer_id` (`customer_id`),
  KEY `return_user_id` (`user_id`),
  CONSTRAINT `return_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `accounts` (`account_id`),
  CONSTRAINT `return_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------
-- Table structure for sales_order_items
-- ----------------------------
DROP TABLE IF EXISTS `sales_order_items`;
CREATE TABLE `sales_order_items` (
  `order_item_id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) DEFAULT NULL,
  `product_id` int(11) DEFAULT NULL,
  `quantity` int(11) DEFAULT NULL,
  `unit_price` decimal(10,2) DEFAULT NULL,
  `total_price` decimal(10,2) DEFAULT NULL,
  `unit_cost` decimal(10,2) DEFAULT NULL,
  `price_type` enum('unit_price_usd','whole_price_usd','grandwhole_price_usd','latest') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`order_item_id`),
  KEY `order_id` (`order_id`),
  KEY `product_id` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Table structure for sales_orders
-- ----------------------------
DROP TABLE IF EXISTS `sales_orders`;
CREATE TABLE `sales_orders` (
  `order_id` int(11) NOT NULL AUTO_INCREMENT,
  `invoice_number` varchar(100) CHARACTER SET utf8 COLLATE utf8_general_ci DEFAULT NULL,
  `journal_voucher_id` int(11) NOT NULL,
  `customer_id` int(11) DEFAULT NULL,
  `user_id` int(11) NOT NULL,
  `order_datetime` datetime DEFAULT CURRENT_TIMESTAMP,
  `total_amount` decimal(10,2) DEFAULT NULL,
  `total_cost` decimal(10,2) DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`order_id`),
  KEY `customer_id` (`customer_id`),
  KEY `sales_orders_users_FK` (`user_id`),
  CONSTRAINT `sales_orders_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `accounts` (`account_id`),
  CONSTRAINT `sales_orders_users_FK` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Table structure for users
-- ----------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `user_id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(255) CHARACTER SET utf8 COLLATE utf8_general_ci NOT NULL,
  `password` varchar(255) NOT NULL,
  `user_type` enum('admin','user') NOT NULL DEFAULT 'user',
  `first_name` varchar(50) DEFAULT NULL,
  `last_name` varchar(50) CHARACTER SET utf8 COLLATE utf8_general_ci DEFAULT NULL,
  `last_login` datetime DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=21 DEFAULT CHARSET=utf8;

-- ----------------------------
-- Records of users
-- ----------------------------
BEGIN;
INSERT INTO `users` VALUES (17, 'admin', '$2a$10$brjbiuJ7vWFPLGeaPXC63unpLYNZ2hbC.rsT1/qMh4aBokGAOSjn6', 'admin', 'Hassan', 'Hassoun', '2025-06-11 11:46:32', 0);
COMMIT;

SET FOREIGN_KEY_CHECKS = 1;
