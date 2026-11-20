package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/vitrine/video-commerce-engine/backend/internal/store"
	"golang.org/x/crypto/bcrypt"
)

const sessionCookie = "vitrine_session"
const sessionDuration = 7 * 24 * time.Hour
const resetDuration = 30 * time.Minute

type authUserKey struct{}

func (s *Server) signup(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Dados de cadastro inválidos.")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Email = normalizeEmail(input.Email)
	if len([]rune(input.Name)) < 2 || len([]rune(input.Name)) > 120 || !validEmail(input.Email) {
		writeError(w, http.StatusUnprocessableEntity, "Informe nome e e-mail válidos.")
		return
	}
	if len(input.Password) < 8 || len(input.Password) > 72 {
		writeError(w, http.StatusUnprocessableEntity, "A senha deve ter entre 8 e 72 caracteres.")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		s.logger.Error("hash password", "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível criar a conta.")
		return
	}
	user, err := s.store.CreateUser(r.Context(), input.Name, input.Email, string(hash))
	if errors.Is(err, store.ErrEmailTaken) {
		writeError(w, http.StatusConflict, "Já existe uma conta com este e-mail.")
		return
	}
	if err != nil {
		s.logger.Error("create user", "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível criar a conta.")
		return
	}
	if err := s.startSession(w, r, user.ID); err != nil {
		s.logger.Error("create session", "error", err)
		writeError(w, http.StatusInternalServerError, "Conta criada, mas não foi possível iniciar a sessão.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": publicUser(user)})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Dados de login inválidos.")
		return
	}
	user, err := s.store.FindUserByEmail(r.Context(), normalizeEmail(input.Email))
	if err != nil || bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(input.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "E-mail ou senha inválidos.")
		return
	}
	if err := s.startSession(w, r, user.ID); err != nil {
		s.logger.Error("create session", "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível iniciar a sessão.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": publicUser(user)})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"user": publicUser(currentUser(r))})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		_ = s.store.DeleteSession(r.Context(), hashToken(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.cookieSecure, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email string `json:"email"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Informe um e-mail válido.")
		return
	}
	user, err := s.store.FindUserByEmail(r.Context(), normalizeEmail(input.Email))
	if err == nil {
		token, tokenHash, tokenErr := newToken()
		if tokenErr == nil && s.store.CreatePasswordReset(r.Context(), tokenHash, user.ID, time.Now().Add(resetDuration)) == nil {
			s.logger.Info("password reset requested", "email", user.Email, "reset_url", fmt.Sprintf("%s/?token=%s", s.appBaseURL, token))
		}
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"message": "Se o e-mail estiver cadastrado, enviaremos instruções de recuperação."})
}

func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Dados de recuperação inválidos.")
		return
	}
	if len(input.Token) < 32 || len(input.Password) < 8 || len(input.Password) > 72 {
		writeError(w, http.StatusUnprocessableEntity, "Token ou senha inválidos.")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível redefinir a senha.")
		return
	}
	if err := s.store.ConsumePasswordReset(r.Context(), hashToken(input.Token), string(hash)); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusUnprocessableEntity, "O link de recuperação expirou ou já foi utilizado.")
		return
	} else if err != nil {
		s.logger.Error("consume password reset", "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível redefinir a senha.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "Senha redefinida com sucesso."})
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookie)
		if err != nil || cookie.Value == "" {
			writeError(w, http.StatusUnauthorized, "Faça login para continuar.")
			return
		}
		user, err := s.store.FindSessionUser(r.Context(), hashToken(cookie.Value))
		if errors.Is(err, sql.ErrNoRows) || err != nil {
			writeError(w, http.StatusUnauthorized, "Sua sessão expirou. Faça login novamente.")
			return
		}
		next.ServeHTTP(w, r.WithContext(contextWithUser(r, user)))
	})
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID string) error {
	token, tokenHash, err := newToken()
	if err != nil {
		return err
	}
	if err := s.store.CreateSession(r.Context(), tokenHash, userID, time.Now().Add(sessionDuration)); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", MaxAge: int(sessionDuration.Seconds()), HttpOnly: true, Secure: s.cookieSecure, SameSite: http.SameSiteLaxMode})
	return nil
}

func newToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := hex.EncodeToString(raw)
	return token, hashToken(token), nil
}
func hashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}
func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }
func validEmail(email string) bool {
	return strings.Contains(email, "@") && !strings.ContainsAny(email, " \t\r\n") && len(email) <= 254
}
func publicUser(user store.User) map[string]string {
	return map[string]string{"id": user.ID, "name": user.Name, "email": user.Email}
}
func currentUser(r *http.Request) store.User {
	user, _ := r.Context().Value(authUserKey{}).(store.User)
	return user
}
func contextWithUser(r *http.Request, user store.User) context.Context {
	return context.WithValue(r.Context(), authUserKey{}, user)
}
