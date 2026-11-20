package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/vitrine/video-commerce-engine/backend/internal/domain"
	"github.com/vitrine/video-commerce-engine/backend/internal/storage"
	"github.com/vitrine/video-commerce-engine/backend/internal/store"
	"github.com/vitrine/video-commerce-engine/backend/internal/tasks"
)

const maxJSONBody = 1 << 20

var (
	idPattern    = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	pricePattern = regexp.MustCompile(`^(?:\d{1,3}(?:\.\d{3})*|\d+)(?:,\d{1,2})?$`)
)

type Server struct {
	store        *store.Store
	db           *sql.DB
	images       *storage.Local
	queue        *asynq.Client
	logger       *slog.Logger
	appBaseURL   string
	cookieSecure bool
	handler      http.Handler
}

func New(db *sql.DB, repository *store.Store, images *storage.Local, queue *asynq.Client, logger *slog.Logger, appBaseURL string, cookieSecure bool) *Server {
	server := &Server{db: db, store: repository, images: images, queue: queue, logger: logger, appBaseURL: strings.TrimRight(appBaseURL, "/"), cookieSecure: cookieSecure}
	router := chi.NewRouter()
	router.Get("/healthz", server.health)
	router.Route("/api/v1", func(router chi.Router) {
		router.Post("/auth/signup", server.signup)
		router.Post("/auth/login", server.login)
		router.Post("/auth/forgot-password", server.forgotPassword)
		router.Post("/auth/reset-password", server.resetPassword)
		router.Group(func(router chi.Router) {
			router.Use(server.requireAuth)
			router.Get("/auth/me", server.me)
			router.Post("/auth/logout", server.logout)
			router.Post("/uploads", server.upload)
			router.Get("/uploads/{key}", server.getUpload)
			router.Get("/projects", server.listProjects)
			router.Post("/projects", server.createProject)
			router.Post("/projects/import", server.importProject)
			router.Get("/jobs/{id}", server.getJob)
			router.Put("/projects/{id}", server.updateProject)
		})
	})
	server.handler = router
	return server
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		s.logger.Error("health check failed", "error", err)
		writeError(w, http.StatusServiceUnavailable, "O banco de dados está indisponível.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, storage.MaxImageSize+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		if r.MultipartForm != nil {
			if cleanupErr := r.MultipartForm.RemoveAll(); cleanupErr != nil {
				s.logger.Warn("remove temporary upload files", "error", cleanupErr)
			}
		}
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeError(w, http.StatusRequestEntityTooLarge, "A requisição de upload excede o limite permitido.")
			return
		}
		writeError(w, http.StatusBadRequest, "Envie uma imagem JPG, PNG ou WebP de até 15 MB.")
		return
	}
	if r.MultipartForm != nil {
		defer func() {
			if err := r.MultipartForm.RemoveAll(); err != nil {
				s.logger.Warn("remove temporary upload files", "error", err)
			}
		}()
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		writeError(w, http.StatusBadRequest, "O campo image é obrigatório.")
		return
	}
	defer file.Close()
	if header.Size > storage.MaxImageSize {
		writeError(w, http.StatusRequestEntityTooLarge, "A imagem deve ter no máximo 15 MB.")
		return
	}
	content, err := io.ReadAll(io.LimitReader(file, storage.MaxImageSize+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Não foi possível ler o arquivo enviado.")
		return
	}
	if len(content) == 0 || len(content) > storage.MaxImageSize {
		writeError(w, http.StatusRequestEntityTooLarge, "A imagem deve ter entre 1 byte e 15 MB.")
		return
	}
	contentType, extension, err := storage.DetectImageType(content)
	if err != nil {
		writeError(w, http.StatusUnsupportedMediaType, err.Error())
		return
	}
	key, err := s.images.Save(bytes.NewReader(content), extension)
	if err != nil {
		s.logger.Error("save product image", "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível salvar a imagem.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"imageKey":  key,
		"imageUrl":  "/api/v1/uploads/" + key,
		"mediaType": contentType,
	})
}

func (s *Server) getUpload(w http.ResponseWriter, r *http.Request) {
	file, contentType, err := s.images.Open(chi.URLParam(r, "key"))
	if err != nil {
		writeError(w, http.StatusNotFound, "Imagem não encontrada.")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "product-image", time.Time{}, file)
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.store.ListProjects(r.Context())
	if err != nil {
		s.logger.Error("list projects", "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível carregar os projetos.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Product       string `json:"product"`
		Goal          string `json:"goal"`
		Platform      string `json:"platform"`
		Ratio         string `json:"ratio"`
		Price         string `json:"price"`
		OriginalPrice string `json:"originalPrice"`
		ImageKey      string `json:"imageKey"`
	}
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "Dados de campanha inválidos.")
		return
	}
	input := domain.Input{
		Product: strings.TrimSpace(request.Product), Goal: request.Goal, Platform: request.Platform,
		Ratio: request.Ratio, Price: strings.TrimSpace(request.Price), OriginalPrice: strings.TrimSpace(request.OriginalPrice),
	}
	if err := validateInput(input); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	imageKey := strings.TrimSpace(request.ImageKey)
	if !s.images.Exists(imageKey) {
		writeError(w, http.StatusUnprocessableEntity, "Envie uma imagem válida antes de criar a campanha.")
		return
	}

	project, jobID, err := s.store.CreateProject(r.Context(), input, imageKey)
	if err != nil {
		s.logger.Error("create project", "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível salvar a campanha.")
		return
	}
	payload, err := json.Marshal(tasks.CampaignPayload{JobID: jobID, ProjectID: project.ID, Input: input})
	if err == nil {
		_, err = s.queue.EnqueueContext(r.Context(), asynq.NewTask(tasks.CampaignGenerate, payload), asynq.TaskID(jobID), asynq.MaxRetry(5))
	}
	if err != nil {
		s.logger.Error("enqueue campaign", "job_id", jobID, "error", err)
		if markErr := s.store.MarkEnqueueFailed(r.Context(), jobID, project.ID, "Não foi possível iniciar o worker."); markErr != nil {
			s.logger.Error("persist enqueue failure", "job_id", jobID, "error", markErr)
		}
		writeError(w, http.StatusServiceUnavailable, "A campanha foi salva, mas a fila de processamento está indisponível.")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"project": project, "jobId": jobID})
}

func (s *Server) importProject(w http.ResponseWriter, r *http.Request) {
	var project store.LegacyProject
	if err := decodeJSON(w, r, &project); err != nil {
		writeError(w, http.StatusBadRequest, "Projeto local inválido para importação.")
		return
	}
	if project.LegacyID == "" || len(project.LegacyID) > 64 || project.Title == "" || project.Product == "" ||
		project.Campaign.Provider != "demo" || project.Campaign.Hook == "" || project.Campaign.Caption == "" {
		writeError(w, http.StatusUnprocessableEntity, "O projeto local não contém os dados necessários para importação.")
		return
	}
	if err := validateInput(domain.Input{Product: project.Product, Goal: project.Goal, Platform: project.Platform, Ratio: project.Ratio, Price: project.Price, OriginalPrice: project.OriginalPrice}); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if project.ImageKey != nil && !s.images.Exists(*project.ImageKey) {
		writeError(w, http.StatusUnprocessableEntity, "A imagem do projeto local ainda não foi enviada.")
		return
	}
	imported, err := s.store.ImportProject(r.Context(), project)
	if err != nil {
		s.logger.Error("import legacy project", "legacy_id", project.LegacyID, "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível importar o projeto local.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": imported})
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !idPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "Identificador de job inválido.")
		return
	}
	job, err := s.store.GetJob(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Job não encontrado.")
		return
	}
	if err != nil {
		s.logger.Error("get job", "job_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível consultar o job.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": job})
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !idPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "Identificador de projeto inválido.")
		return
	}
	var input store.UpdateProject
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Dados de edição inválidos.")
		return
	}
	if input.Version < 1 || input.Ratio != "9:16" && input.Ratio != "1:1" && input.Ratio != "4:5" && input.Ratio != "16:9" ||
		input.Background < 0 || input.Background > 2 || input.Headline == "" ||
		input.Campaign.Provider != "demo" || input.Campaign.Hook == "" || input.Campaign.Benefit == "" ||
		input.Campaign.Offer == "" || input.Campaign.CTA == "" || input.Campaign.Caption == "" {
		writeError(w, http.StatusUnprocessableEntity, "Revise os textos e o formato antes de salvar.")
		return
	}
	if input.Price != "" && (len(input.Price) > 32 || !pricePattern.MatchString(input.Price)) {
		writeError(w, http.StatusUnprocessableEntity, "Preço inválido.")
		return
	}
	if input.Price != "" && currentPriceIsInvalid(input.Price) {
		writeError(w, http.StatusUnprocessableEntity, "O preço promocional deve ser maior que zero.")
		return
	}
	current, err := s.store.GetProject(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Projeto não encontrado.")
		return
	}
	if err != nil {
		s.logger.Error("read project before update", "project_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível carregar o projeto.")
		return
	}
	if input.Price != "" && current.OriginalPrice != "" && parsePrice(input.Price) >= parsePrice(current.OriginalPrice) {
		writeError(w, http.StatusUnprocessableEntity, "O preço promocional deve ser menor que o preço original.")
		return
	}
	project, err := s.store.UpdateProject(r.Context(), id, input)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, http.StatusNotFound, "Projeto não encontrado.")
	case errors.Is(err, store.ErrVersionConflict):
		writeError(w, http.StatusConflict, err.Error())
	case err != nil:
		s.logger.Error("update project", "project_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "Não foi possível salvar as alterações.")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"project": project})
	}
}

func validateInput(input domain.Input) error {
	if strings.TrimSpace(input.Product) == "" || len([]rune(input.Product)) > 120 {
		return errors.New("O nome do produto deve ter entre 1 e 120 caracteres.")
	}
	switch input.Goal {
	case "Oferta relâmpago", "Lançamento", "Dor e solução", "Prova social":
	default:
		return errors.New("Selecione um objetivo de campanha válido.")
	}
	switch input.Platform {
	case "TikTok", "Instagram Reels", "Shopee Video":
	default:
		return errors.New("Selecione uma plataforma válida.")
	}
	switch input.Ratio {
	case "9:16", "1:1", "4:5", "16:9":
	default:
		return errors.New("Selecione um formato de vídeo válido.")
	}
	for _, price := range []string{input.Price, input.OriginalPrice} {
		if price != "" && (!pricePattern.MatchString(price) || len(price) > 32) {
			return errors.New("Informe os preços no formato 89,90.")
		}
		if price != "" && parsePrice(price) <= 0 {
			return errors.New("Os preços devem ser maiores que zero.")
		}
	}
	if input.Price != "" && input.OriginalPrice != "" && parsePrice(input.Price) >= parsePrice(input.OriginalPrice) {
		return errors.New("O preço promocional deve ser menor que o preço original.")
	}
	return nil
}

func currentPriceIsInvalid(value string) bool {
	return parsePrice(value) <= 0
}

func parsePrice(value string) float64 {
	normalized := strings.ReplaceAll(strings.ReplaceAll(value, ".", ""), ",", ".")
	price, _ := strconv.ParseFloat(normalized, 64)
	return price
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dest any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	return decodeJSONFromReader(r.Body, dest)
}

func decodeJSONFromReader(reader io.Reader, dest any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("unexpected trailing JSON data")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("write JSON response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
