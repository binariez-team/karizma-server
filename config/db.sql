-- ----------------------------
-- Table structure for users
-- ----------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `user_id` int(11) NOT NULL AUTO_INCREMENT,
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
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8;

-- ----------------------------
-- Records of users
-- ----------------------------
BEGIN;
INSERT INTO `users` VALUES (1, 'admin', '$2a$10$brjbiuJ7vWFPLGeaPXC63unpLYNZ2hbC.rsT1/qMh4aBokGAOSjn6', 'admin', 'admin', 'admin', 0, 1, 0, 0, 0);
INSERT INTO `users` VALUES (14, 'admini', '$2a$10$brjbiuJ7vWFPLGeaPXC63unpLYNZ2hbC.rsT1/qMh4aBokGAOSjn6', 'user', NULL, NULL, 0, 0, 0, 0, 0);
INSERT INTO `users` VALUES (15, 'all', 'a181a603769c1f98ad927e7367c7aa51', 'user', 'all', 'permissions', 1, 1, 1, 1, 0);
COMMIT;