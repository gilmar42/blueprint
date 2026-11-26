CREATE TABLE IF NOT EXISTS tenants (
    id CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS projects (
    id CHAR(36) NOT NULL PRIMARY KEY,
    tenant_id CHAR(36) NOT NULL,
    legacy_id VARCHAR(64) NULL,
    title VARCHAR(120) NOT NULL,
    product VARCHAR(120) NOT NULL,
    goal VARCHAR(80) NOT NULL,
    platform VARCHAR(40) NOT NULL,
    ratio VARCHAR(8) NOT NULL,
    price VARCHAR(32) NOT NULL DEFAULT '',
    original_price VARCHAR(32) NOT NULL DEFAULT '',
    headline VARCHAR(280) NOT NULL DEFAULT '',
    campaign_json JSON NULL,
    image_key VARCHAR(80) NULL,
    status VARCHAR(24) NOT NULL,
    progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    background TINYINT UNSIGNED NOT NULL DEFAULT 0,
    latest_job_id CHAR(36) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_projects_tenant_legacy (tenant_id, legacy_id),
    KEY idx_projects_tenant_created (tenant_id, created_at),
    CONSTRAINT fk_projects_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS render_jobs (
    id CHAR(36) NOT NULL PRIMARY KEY,
    tenant_id CHAR(36) NOT NULL,
    project_id CHAR(36) NOT NULL,
    job_type VARCHAR(48) NOT NULL,
    status VARCHAR(24) NOT NULL,
    progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
    error_message VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    started_at DATETIME(6) NULL,
    finished_at DATETIME(6) NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    KEY idx_jobs_tenant_created (tenant_id, created_at),
    CONSTRAINT fk_jobs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
    CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES projects (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
