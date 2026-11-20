package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hibiken/asynq"
	"github.com/vitrine/video-commerce-engine/backend/internal/config"
	"github.com/vitrine/video-commerce-engine/backend/internal/httpapi"
	"github.com/vitrine/video-commerce-engine/backend/internal/platform"
	"github.com/vitrine/video-commerce-engine/backend/internal/storage"
	"github.com/vitrine/video-commerce-engine/backend/internal/store"
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
	images, err := storage.NewLocal(cfg.Uploads)
	if err != nil {
		logger.Error("configure image storage", "error", err)
		os.Exit(1)
	}
	queue := asynq.NewClient(asynq.RedisClientOpt{Addr: cfg.RedisAddr, Password: cfg.RedisPass})
	defer queue.Close()

	repository := store.New(db, cfg.TenantID)
	api := httpapi.New(db, repository, images, queue, logger, cfg.AppBaseURL, cfg.CookieSecure)
	server := &http.Server{
		Addr:              cfg.Address,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		logger.Info("API listening", "address", cfg.Address)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("serve API", "error", err)
			stop()
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown API", "error", err)
	}
}
