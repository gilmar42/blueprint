package tasks

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hibiken/asynq"
	"github.com/vitrine/video-commerce-engine/backend/internal/domain"
	"github.com/vitrine/video-commerce-engine/backend/internal/store"
)

const CampaignGenerate = "campaign:generate"

type CampaignPayload struct {
	JobID     string       `json:"jobId"`
	ProjectID string       `json:"projectId"`
	Input     domain.Input `json:"input"`
}

type Handler struct {
	store *store.Store
}

func NewHandler(repository *store.Store) *Handler {
	return &Handler{store: repository}
}

func (h *Handler) ProcessCampaign(ctx context.Context, task *asynq.Task) error {
	var payload CampaignPayload
	if err := json.Unmarshal(task.Payload(), &payload); err != nil {
		return fmt.Errorf("decode campaign task: %w", err)
	}
	if payload.JobID == "" || payload.ProjectID == "" {
		return fmt.Errorf("campaign task is missing identifiers")
	}
	started, err := h.store.StartJob(ctx, payload.JobID, payload.ProjectID)
	if err != nil {
		return err
	}
	if !started {
		return nil
	}
	campaign := domain.GenerateCampaign(payload.Input)
	return h.store.CompleteJob(ctx, payload.JobID, payload.ProjectID, campaign)
}

func (h *Handler) HandleError(ctx context.Context, task *asynq.Task, _ error) error {
	retryCount, retryOK := asynq.GetRetryCount(ctx)
	maxRetries, maxOK := asynq.GetMaxRetry(ctx)
	if !retryOK || !maxOK || retryCount < maxRetries {
		return nil
	}
	var payload CampaignPayload
	if err := json.Unmarshal(task.Payload(), &payload); err != nil {
		return fmt.Errorf("decode failed campaign task: %w", err)
	}
	return h.store.FailJob(ctx, payload.JobID, payload.ProjectID, "O processamento falhou após várias tentativas. Consulte os logs do worker.")
}
