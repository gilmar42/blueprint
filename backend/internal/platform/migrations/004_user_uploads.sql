CREATE TABLE user_uploads (
    image_key VARCHAR(80) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY idx_uploads_user_created (user_id, created_at),
    CONSTRAINT fk_uploads_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO user_uploads (image_key, user_id, size_bytes)
SELECT image_key, owner_user_id, 0
FROM projects
WHERE image_key IS NOT NULL AND owner_user_id IS NOT NULL
GROUP BY image_key, owner_user_id;
