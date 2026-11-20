package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/vitrine/video-commerce-engine/backend/internal/domain"
)

type Store struct {
	db       *sql.DB
	tenantID string
}

type Project struct {
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	Product       string          `json:"product"`
	Goal          string          `json:"goal"`
	Platform      string          `json:"platform"`
	Ratio         string          `json:"ratio"`
	Price         string          `json:"price"`
	OriginalPrice string          `json:"originalPrice,omitempty"`
	Headline      string          `json:"headline"`
	Campaign      domain.Campaign `json:"campaign"`
	ImageKey      *string         `json:"imageKey,omitempty"`
	ImageURL      string          `json:"imageUrl,omitempty"`
	Status        string          `json:"status"`
	Progress      int             `json:"progress"`
	ErrorMessage  string          `json:"errorMessage,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	Version       int             `json:"version"`
	Background    int             `json:"background"`
	LatestJobID   string          `json:"jobId,omitempty"`
}

type Job struct {
	ID         string     `json:"id"`
	ProjectID  string     `json:"projectId"`
	Status     string     `json:"status"`
	Progress   int        `json:"progress"`
	Error      string     `json:"error,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
}

type LegacyProject struct {
	LegacyID      string          `json:"legacyId"`
	Title         string          `json:"title"`
	Product       string          `json:"product"`
	Goal          string          `json:"goal"`
	Platform      string          `json:"platform"`
	Ratio         string          `json:"ratio"`
	Price         string          `json:"price"`
	OriginalPrice string          `json:"originalPrice"`
	Headline      string          `json:"headline"`
	Campaign      domain.Campaign `json:"campaign"`
	ImageKey      *string         `json:"imageKey"`
	Version       int             `json:"version"`
	Background    int             `json:"background"`
	CreatedAt     string          `json:"createdAt"`
}

type UpdateProject struct {
	Price      string          `json:"price"`
	Ratio      string          `json:"ratio"`
	Headline   string          `json:"headline"`
	Campaign   domain.Campaign `json:"campaign"`
	Background int             `json:"background"`
	Version    int             `json:"version"`
}

func New(db *sql.DB, tenantID string) *Store {
	return &Store{db: db, tenantID: tenantID}
}

func NewID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate identifier: %w", err)
	}
	encoded := hex.EncodeToString(value)
	return encoded[:8] + "-" + encoded[8:12] + "-4" + encoded[13:16] + "-8" + encoded[17:20] + "-" + encoded[20:], nil
}

func (s *Store) CreateProject(ctx context.Context, input domain.Input, imageKey string) (Project, string, error) {
	projectID, err := NewID()
	if err != nil {
		return Project{}, "", err
	}
	jobID, err := NewID()
	if err != nil {
		return Project{}, "", err
	}
	project := Project{
		ID:            projectID,
		Title:         input.Product,
		Product:       input.Product,
		Goal:          input.Goal,
		Platform:      input.Platform,
		Ratio:         input.Ratio,
		Price:         input.Price,
		OriginalPrice: input.OriginalPrice,
		Status:        "queued",
		Progress:      0,
		CreatedAt:     time.Now().UTC(),
		Version:       1,
		Background:    0,
		LatestJobID:   jobID,
	}
	project.ImageKey = &imageKey
	project.ImageURL = "/api/v1/uploads/" + url.PathEscape(imageKey)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Project{}, "", fmt.Errorf("begin campaign transaction: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx, `INSERT INTO projects
		(id, tenant_id, title, product, goal, platform, ratio, price, original_price, image_key, status, progress, version, background, latest_job_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 1, 0, ?)`,
		project.ID, s.tenantID, project.Title, project.Product, project.Goal, project.Platform, project.Ratio,
		project.Price, project.OriginalPrice, imageKey, jobID)
	if err != nil {
		return Project{}, "", fmt.Errorf("insert campaign: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO render_jobs (id, tenant_id, project_id, job_type, status, progress)
		VALUES (?, ?, ?, 'campaign.generate', 'queued', 0)`, jobID, s.tenantID, projectID)
	if err != nil {
		return Project{}, "", fmt.Errorf("insert campaign job: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Project{}, "", fmt.Errorf("commit campaign transaction: %w", err)
	}
	return project, jobID, nil
}

func (s *Store) MarkEnqueueFailed(ctx context.Context, jobID, projectID, message string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin failed enqueue transaction: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE render_jobs SET status='failed', error_message=?, finished_at=UTC_TIMESTAMP(6)
		WHERE id=? AND tenant_id=? AND status='queued'`, message, jobID, s.tenantID)
	if err != nil {
		return fmt.Errorf("mark job enqueue failure: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check failed enqueue job: %w", err)
	}
	if affected == 0 {
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET status='failed'
		WHERE id=? AND tenant_id=? AND latest_job_id=?`, projectID, s.tenantID, jobID); err != nil {
		return fmt.Errorf("mark project enqueue failure: %w", err)
	}
	return tx.Commit()
}

func (s *Store) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, product, goal, platform, ratio, price, original_price,
		headline, campaign_json, image_key, status, progress, created_at, version, background, latest_job_id,
		COALESCE((SELECT error_message FROM render_jobs WHERE render_jobs.id=projects.latest_job_id
			AND render_jobs.tenant_id=projects.tenant_id), '')
		FROM projects WHERE tenant_id=? ORDER BY created_at DESC`, s.tenantID)
	if err != nil {
		return nil, fmt.Errorf("query projects: %w", err)
	}
	defer rows.Close()
	projects := make([]Project, 0)
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate projects: %w", err)
	}
	return projects, nil
}

func (s *Store) GetProject(ctx context.Context, id string) (Project, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, title, product, goal, platform, ratio, price, original_price,
		headline, campaign_json, image_key, status, progress, created_at, version, background, latest_job_id,
		COALESCE((SELECT error_message FROM render_jobs WHERE render_jobs.id=projects.latest_job_id
			AND render_jobs.tenant_id=projects.tenant_id), '')
		FROM projects WHERE tenant_id=? AND id=?`, s.tenantID, id)
	project, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, sql.ErrNoRows
	}
	return project, err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanProject(row scanner) (Project, error) {
	var project Project
	var campaignJSON []byte
	var imageKey sql.NullString
	var latestJobID sql.NullString
	var errorMessage string
	if err := row.Scan(
		&project.ID, &project.Title, &project.Product, &project.Goal, &project.Platform, &project.Ratio,
		&project.Price, &project.OriginalPrice, &project.Headline, &campaignJSON, &imageKey, &project.Status,
		&project.Progress, &project.CreatedAt, &project.Version, &project.Background, &latestJobID, &errorMessage,
	); err != nil {
		return Project{}, fmt.Errorf("scan project: %w", err)
	}
	project.CreatedAt = project.CreatedAt.UTC()
	project.ErrorMessage = errorMessage
	if imageKey.Valid {
		project.ImageKey = &imageKey.String
		project.ImageURL = "/api/v1/uploads/" + url.PathEscape(imageKey.String)
	}
	if latestJobID.Valid {
		project.LatestJobID = latestJobID.String
	}
	if len(campaignJSON) > 0 {
		if err := json.Unmarshal(campaignJSON, &project.Campaign); err != nil {
			return Project{}, fmt.Errorf("decode campaign: %w", err)
		}
	}
	return project, nil
}

func (s *Store) GetJob(ctx context.Context, id string) (Job, error) {
	var job Job
	var errorMessage sql.NullString
	var startedAt, finishedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT id, project_id, status, progress, error_message, created_at, started_at, finished_at
		FROM render_jobs WHERE tenant_id=? AND id=?`, s.tenantID, id).
		Scan(&job.ID, &job.ProjectID, &job.Status, &job.Progress, &errorMessage, &job.CreatedAt, &startedAt, &finishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, sql.ErrNoRows
	}
	if err != nil {
		return Job{}, fmt.Errorf("query job: %w", err)
	}
	job.CreatedAt = job.CreatedAt.UTC()
	if errorMessage.Valid {
		job.Error = errorMessage.String
	}
	if startedAt.Valid {
		value := startedAt.Time.UTC()
		job.StartedAt = &value
	}
	if finishedAt.Valid {
		value := finishedAt.Time.UTC()
		job.FinishedAt = &value
	}
	return job, nil
}

func (s *Store) ImportProject(ctx context.Context, project LegacyProject) (Project, error) {
	id, err := NewID()
	if err != nil {
		return Project{}, err
	}
	createdAt := time.Now().UTC()
	if parsed, err := time.Parse(time.RFC3339Nano, project.CreatedAt); err == nil {
		createdAt = parsed.UTC()
	}
	campaignJSON, err := json.Marshal(project.Campaign)
	if err != nil {
		return Project{}, fmt.Errorf("encode legacy campaign: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Project{}, fmt.Errorf("begin legacy import: %w", err)
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO projects
		(id, tenant_id, legacy_id, title, product, goal, platform, ratio, price, original_price, headline, campaign_json,
		image_key, status, progress, version, background, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview', 100, ?, ?, ?)
		ON DUPLICATE KEY UPDATE id=id`,
		id, s.tenantID, project.LegacyID, project.Title, project.Product, project.Goal, project.Platform, project.Ratio,
		project.Price, project.OriginalPrice, project.Headline, campaignJSON, project.ImageKey,
		max(project.Version, 1), min(max(project.Background, 0), 2), createdAt)
	if err != nil {
		return Project{}, fmt.Errorf("insert legacy project: %w", err)
	}
	var persistedID string
	if err := tx.QueryRowContext(ctx, "SELECT id FROM projects WHERE tenant_id=? AND legacy_id=?", s.tenantID, project.LegacyID).Scan(&persistedID); err != nil {
		return Project{}, fmt.Errorf("find imported project: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Project{}, fmt.Errorf("commit legacy import: %w", err)
	}
	return s.GetProject(ctx, persistedID)
}

func (s *Store) UpdateProject(ctx context.Context, id string, input UpdateProject) (Project, error) {
	campaignJSON, err := json.Marshal(input.Campaign)
	if err != nil {
		return Project{}, fmt.Errorf("encode campaign: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `UPDATE projects SET price=?, ratio=?, headline=?, campaign_json=?, background=?, version=version+1
		WHERE id=? AND tenant_id=? AND version=?`, input.Price, input.Ratio, input.Headline, campaignJSON,
		input.Background, id, s.tenantID, input.Version)
	if err != nil {
		return Project{}, fmt.Errorf("update project: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return Project{}, fmt.Errorf("check project update: %w", err)
	}
	if rows == 0 {
		_, err := s.GetProject(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return Project{}, sql.ErrNoRows
		}
		if err != nil {
			return Project{}, err
		}
		return Project{}, ErrVersionConflict
	}
	return s.GetProject(ctx, id)
}

var ErrVersionConflict = errors.New("o projeto foi alterado em outra sessão; atualize e tente novamente")

func (s *Store) StartJob(ctx context.Context, jobID, projectID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin job transaction: %w", err)
	}
	defer tx.Rollback()
	var status string
	err = tx.QueryRowContext(ctx, "SELECT status FROM render_jobs WHERE id=? AND tenant_id=? AND project_id=? FOR UPDATE",
		jobID, s.tenantID, projectID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return false, sql.ErrNoRows
	}
	if err != nil {
		return false, fmt.Errorf("read job status: %w", err)
	}
	if status == "completed" || status == "failed" {
		return false, nil
	}
	if status != "queued" && status != "processing" {
		return false, fmt.Errorf("unexpected job status %q", status)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE render_jobs SET status='processing', progress=50, started_at=COALESCE(started_at, UTC_TIMESTAMP(6))
		WHERE id=? AND tenant_id=?`, jobID, s.tenantID); err != nil {
		return false, fmt.Errorf("mark job processing: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET status='processing', progress=50
		WHERE id=? AND tenant_id=? AND latest_job_id=?`, projectID, s.tenantID, jobID); err != nil {
		return false, fmt.Errorf("mark project processing: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit job start: %w", err)
	}
	return true, nil
}

func (s *Store) CompleteJob(ctx context.Context, jobID, projectID string, campaign domain.Campaign) error {
	campaignJSON, err := json.Marshal(campaign)
	if err != nil {
		return fmt.Errorf("encode generated campaign: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin job completion: %w", err)
	}
	defer tx.Rollback()
	projectResult, err := tx.ExecContext(ctx, `UPDATE projects SET campaign_json=?, headline=?, status='preview', progress=100
		WHERE id=? AND tenant_id=? AND latest_job_id=?`, campaignJSON, campaign.Hook, projectID, s.tenantID, jobID)
	if err != nil {
		return fmt.Errorf("save generated campaign: %w", err)
	}
	projectRows, err := projectResult.RowsAffected()
	if err != nil {
		return fmt.Errorf("check generated campaign update: %w", err)
	}
	if projectRows == 0 {
		return fmt.Errorf("project %s no longer references campaign job %s", projectID, jobID)
	}
	jobResult, err := tx.ExecContext(ctx, `UPDATE render_jobs SET status='completed', progress=100, finished_at=UTC_TIMESTAMP(6), error_message=NULL
		WHERE id=? AND tenant_id=? AND status='processing'`, jobID, s.tenantID)
	if err != nil {
		return fmt.Errorf("complete campaign job: %w", err)
	}
	jobRows, err := jobResult.RowsAffected()
	if err != nil {
		return fmt.Errorf("check campaign job completion: %w", err)
	}
	if jobRows == 0 {
		return fmt.Errorf("campaign job %s is no longer processing", jobID)
	}
	return tx.Commit()
}

func (s *Store) FailJob(ctx context.Context, jobID, projectID, message string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin job failure: %w", err)
	}
	defer tx.Rollback()
	jobResult, err := tx.ExecContext(ctx, `UPDATE render_jobs SET status='failed', error_message=?, finished_at=UTC_TIMESTAMP(6)
		WHERE id=? AND tenant_id=? AND status IN ('queued', 'processing')`, message, jobID, s.tenantID)
	if err != nil {
		return fmt.Errorf("mark job failed: %w", err)
	}
	jobRows, err := jobResult.RowsAffected()
	if err != nil {
		return fmt.Errorf("check failed job update: %w", err)
	}
	if jobRows == 0 {
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET status='failed'
		WHERE id=? AND tenant_id=? AND latest_job_id=?`, projectID, s.tenantID, jobID); err != nil {
		return fmt.Errorf("mark project failed: %w", err)
	}
	return tx.Commit()
}
