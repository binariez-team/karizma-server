-- MySQL dump 10.13  Distrib 8.0.19, for macos10.15 (x86_64)
--
-- Host: localhost    Database: karizma
-- ------------------------------------------------------
-- Server version	8.0.19

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `accounts`
--

DROP TABLE IF EXISTS `accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `accounts` (
  `account_id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(100) DEFAULT NULL,
  `name` varchar(255) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `financial_number` varchar(100) DEFAULT NULL,
  `user_id` int DEFAULT NULL,
  `is_customer` tinyint(1) DEFAULT '0',
  `is_supplier` tinyint(1) DEFAULT '0',
  `is_bank` tinyint(1) DEFAULT '0',
  `is_employee` tinyint(1) DEFAULT '0',
  `is_deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`account_id`)
) ENGINE=InnoDB AUTO_INCREMENT=14 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `accounts`
--

LOCK TABLES `accounts` WRITE;
/*!40000 ALTER TABLE `accounts` DISABLE KEYS */;
INSERT INTO `accounts` VALUES (1,NULL,'som3a','leb 123','70123456',NULL,NULL,1,0,0,0,0),(2,NULL,'new name','leb 123','70123456',NULL,14,1,0,0,0,0),(3,NULL,'test','leb 123','70123456',NULL,NULL,1,0,0,0,1),(4,NULL,'som3a','leb 123','70123456',NULL,NULL,0,1,0,0,0),(5,NULL,'new','new 123','444444','123667788',14,1,0,0,0,0),(6,NULL,'test123','new address','1233','1234',14,1,0,0,0,0),(7,NULL,'new name','','','',14,1,0,0,0,1),(8,NULL,'som3a','111','111','1111',14,1,0,0,0,0),(9,NULL,'test','new','123','123',14,1,0,0,0,0),(10,NULL,'testme','my new address 123','12345',NULL,NULL,0,1,0,0,0),(11,NULL,'sasass','sa','123','12345',NULL,0,1,0,0,0),(12,NULL,'saassa','sasa','123assaasasasas',NULL,NULL,0,1,0,0,0),(13,NULL,'asas','saas','saasa',NULL,NULL,0,1,0,0,1);
/*!40000 ALTER TABLE `accounts` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `journal_items`
--

DROP TABLE IF EXISTS `journal_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `journal_items`
--

LOCK TABLES `journal_items` WRITE;
/*!40000 ALTER TABLE `journal_items` DISABLE KEYS */;
/*!40000 ALTER TABLE `journal_items` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `journal_vouchers`
--

DROP TABLE IF EXISTS `journal_vouchers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `journal_vouchers`
--

LOCK TABLES `journal_vouchers` WRITE;
/*!40000 ALTER TABLE `journal_vouchers` DISABLE KEYS */;
/*!40000 ALTER TABLE `journal_vouchers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `products` (
  `product_id` int NOT NULL AUTO_INCREMENT,
  `category_id_fk` int DEFAULT NULL,
  `brand_id_fk` int DEFAULT NULL,
  `sku` varchar(100) DEFAULT NULL,
  `barcode` varchar(255) DEFAULT NULL,
  `product_name` varchar(255) NOT NULL,
  `cost_usd` decimal(10,2) NOT NULL,
  `avg_cost_usd` decimal(10,2) DEFAULT NULL,
  `unit_price_usd` decimal(10,2) DEFAULT NULL,
  `whole_price_usd` decimal(10,2) DEFAULT NULL,
  `grandwhole_price_usd` decimal(10,2) DEFAULT NULL,
  `product_notes` varchar(255) DEFAULT NULL,
  `low_stock_threshold` int DEFAULT NULL,
  `is_deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `products`
--

LOCK TABLES `products` WRITE;
/*!40000 ALTER TABLE `products` DISABLE KEYS */;
/*!40000 ALTER TABLE `products` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `user_id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `user_type` enum('admin','user') NOT NULL DEFAULT 'user',
  `first_name` varchar(50) DEFAULT NULL,
  `last_name` varchar(50) DEFAULT NULL,
  `view_stock` tinyint(1) NOT NULL DEFAULT '0',
  `view_reports` tinyint(1) NOT NULL DEFAULT '0',
  `delete_invoice` tinyint(1) NOT NULL DEFAULT '0',
  `modify_customers` tinyint(1) NOT NULL DEFAULT '0',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=19 DEFAULT CHARSET=utf8;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'admin','$2a$10$brjbiuJ7vWFPLGeaPXC63unpLYNZ2hbC.rsT1/qMh4aBokGAOSjn6','admin','admin','admin',0,1,0,0,0),(14,'admini','$2a$10$brjbiuJ7vWFPLGeaPXC63unpLYNZ2hbC.rsT1/qMh4aBokGAOSjn6','user',NULL,NULL,0,0,0,0,0),(18,'test1','$2a$10$gIlD.VaimRph0pK7TnrWJ.fOsabo1L9dNLBkPKPnrqox650iBQkGW','user','som3a','test',0,0,0,0,0);
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping routines for database 'karizma'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2024-06-13 10:47:45
