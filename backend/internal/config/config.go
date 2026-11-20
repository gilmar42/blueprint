package config

import (
	"fmt"
	"os"
)

const defaultTenantID = "00000000-0000-4000-8000-000000000001"

type Config struct {
	Address      string
	Database     string
	RedisAddr    string
	RedisPass    string
	Uploads      string
	TenantID     string
	AppBaseURL   string
	CookieSecure bool
}

func FromEnv() (Config, error) {
	cfg := Config{
		Address:      env("API_ADDRESS", ":8080"),
		Database:     os.Getenv("DATABASE_DSN"),
		RedisAddr:    env("REDIS_ADDR", "127.0.0.1:6379"),
		RedisPass:    os.Getenv("REDIS_PASSWORD"),
		Uploads:      env("UPLOADS_DIR", "./data/uploads"),
		TenantID:     env("TENANT_ID", defaultTenantID),
		AppBaseURL:   env("APP_BASE_URL", "http://localhost:3000"),
		CookieSecure: os.Getenv("AUTH_COOKIE_SECURE") == "1",
	}
	if cfg.Database == "" {
		return Config{}, fmt.Errorf("DATABASE_DSN is required")
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
