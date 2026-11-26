ALTER TABLE projects
    ADD COLUMN owner_user_id CHAR(36) NULL AFTER tenant_id,
    DROP INDEX uq_projects_tenant_legacy,
    ADD UNIQUE KEY uq_projects_owner_legacy (tenant_id, owner_user_id, legacy_id),
    ADD KEY idx_projects_owner_created (owner_user_id, created_at),
    ADD CONSTRAINT fk_projects_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE;

UPDATE projects p
SET p.owner_user_id = (
    SELECT u.id
    FROM users u
    WHERE u.tenant_id = p.tenant_id
    ORDER BY u.created_at ASC, u.id ASC
    LIMIT 1
)
WHERE p.owner_user_id IS NULL
  AND EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = p.tenant_id);
