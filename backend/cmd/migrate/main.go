package main

import (
	"context"
	"log"

	"github.com/vitrine/video-commerce-engine/backend/internal/config"
	"github.com/vitrine/video-commerce-engine/backend/internal/platform"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	db, err := platform.OpenDatabase(ctx, cfg.Database)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := platform.Migrate(ctx, db); err != nil {
		log.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT IGNORE INTO tenants (id, name) VALUES (?, 'Workspace local')`, cfg.TenantID); err != nil {
		log.Fatal(err)
	}
	log.Println("database migrations applied")
}
