package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrEmailTaken = errors.New("email já cadastrado")

type User struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Email    string    `json:"email"`
	TenantID string    `json:"-"`
	Password string    `json:"-"`
	Created  time.Time `json:"createdAt"`
}

func (s *Store) CreateUser(ctx context.Context, name, email, passwordHash string) (User, error) {
	id, err := NewID()
	if err != nil {
		return User{}, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO users (id, tenant_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)`, id, s.tenantID, name, email, passwordHash)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return User{ID: id, TenantID: s.tenantID, Name: name, Email: email, Password: passwordHash, Created: time.Now().UTC()}, nil
}

func (s *Store) FindUserByEmail(ctx context.Context, email string) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx, `SELECT id, tenant_id, name, email, password_hash, created_at FROM users WHERE tenant_id=? AND email=?`, s.tenantID, email).
		Scan(&user.ID, &user.TenantID, &user.Name, &user.Email, &user.Password, &user.Created)
	if err != nil {
		return User{}, err
	}
	user.Created = user.Created.UTC()
	return user, nil
}

func (s *Store) CreateSession(ctx context.Context, tokenHash, userID string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, tokenHash, userID, expiresAt.UTC())
	return err
}

func (s *Store) FindSessionUser(ctx context.Context, tokenHash string) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx, `SELECT u.id, u.tenant_id, u.name, u.email, u.created_at
		FROM auth_sessions s JOIN users u ON u.id=s.user_id
		WHERE s.id=? AND s.expires_at > UTC_TIMESTAMP(6)`, tokenHash).
		Scan(&user.ID, &user.TenantID, &user.Name, &user.Email, &user.Created)
	if err != nil {
		return User{}, err
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE auth_sessions SET last_seen_at=UTC_TIMESTAMP(6) WHERE id=?`, tokenHash)
	user.Created = user.Created.UTC()
	return user, nil
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id=?`, tokenHash)
	return err
}

func (s *Store) CreatePasswordReset(ctx context.Context, tokenHash, userID string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO password_reset_tokens (id, user_id, expires_at) VALUES (?, ?, ?)`, tokenHash, userID, expiresAt.UTC())
	return err
}

func (s *Store) ConsumePasswordReset(ctx context.Context, tokenHash, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var userID string
	err = tx.QueryRowContext(ctx, `SELECT user_id FROM password_reset_tokens WHERE id=? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP(6) FOR UPDATE`, tokenHash).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return sql.ErrNoRows
	}
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE users SET password_hash=? WHERE id=?`, passwordHash, userID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP(6) WHERE id=?`, tokenHash); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE user_id=?`, userID); err != nil {
		return err
	}
	return tx.Commit()
}
