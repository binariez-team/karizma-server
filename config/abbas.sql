CREATE TABLE `accounts` (
  `account_id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(100) DEFAULT NULL,
  `name` varchar(255) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `financial_number` varchar(100) DEFAULT NULL,
  `balance_usd` decimal(10,2) DEFAULT '0.00',
  `user_id` INT DEFAULT NULL,
  `is_customer` tinyint(1) DEFAULT 0,
  `is_supplier` tinyint(1) DEFAULT 0,
  `is_bank` tinyint(1) DEFAULT 0,
  `is_employee` tinyint(1) DEFAULT 0,
  `is_deleted` tinyint(1) DEFAULT 0,
  PRIMARY KEY (`account_id`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;