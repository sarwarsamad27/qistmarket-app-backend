-- AlterTable
ALTER TABLE `user` ADD COLUMN `session_token` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `device_login_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `new_device_id` VARCHAR(191) NOT NULL,
    `new_fcm_token` VARCHAR(255) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,

    INDEX `device_login_requests_user_id_idx`(`user_id`),
    INDEX `device_login_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `device_login_requests` ADD CONSTRAINT `device_login_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
