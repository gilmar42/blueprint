ALTER TABLE projects
    ADD COLUMN model_key VARCHAR(80) NULL AFTER video_key,
    ADD COLUMN text_notes TEXT NULL AFTER model_key;

CREATE TABLE project_images (
    project_id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    image_key VARCHAR(80) NOT NULL,
    sort_order SMALLINT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (project_id, sort_order),
    UNIQUE KEY uq_project_images_key (project_id, image_key),
    KEY idx_project_images_upload (user_id, image_key),
    CONSTRAINT fk_project_images_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT fk_project_images_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
    CONSTRAINT fk_project_images_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_project_images_upload FOREIGN KEY (image_key) REFERENCES user_uploads (image_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
