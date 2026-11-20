package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/hibiken/asynq"
	"github.com/vitrine/video-commerce-engine/backend/internal/config"
	"github.com/vitrine/video-commerce-engine/backend/internal/platform"
	"github.com/vitrine/video-commerce-engine/backend/internal/store"
	"github.com/vitrine/video-commerce-engine/backend/internal/tasks"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.FromEnv()
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := platform.OpenDatabase(ctx, cfg.Database)
	if err != nil {
		logger.Error("connect database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	repository := store.New(db, cfg.TenantID)
	handler := tasks.NewHandler(repository)
	mux := asynq.NewServeMux()
	mux.HandleFunc(tasks.CampaignGenerate, handler.ProcessCampaign)
	server := asynq.NewServer(
		asynq.RedisClientOpt{Addr: cfg.RedisAddr, Password: cfg.RedisPass},
		asynq.Config{
			Concurrency: 3,
			Queues:      map[string]int{"default": 1},
			ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
				logger.Error("campaign task failed", "type", task.Type(), "error", err)
				if err := handler.HandleError(ctx, task, err); err != nil {
					logger.Error("persist terminal campaign failure", "error", err)
				}
			}),
		},
	)
	go func() {
		logger.Info("campaign worker started")
		if err := server.Run(mux); err != nil {
			logger.Error("run worker", "error", err)
			stop()
		}
	}()
	<-ctx.Done()
	server.Shutdown()
}
