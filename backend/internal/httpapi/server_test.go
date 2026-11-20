package httpapi

import (
	"bytes"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vitrine/video-commerce-engine/backend/internal/domain"
	"github.com/vitrine/video-commerce-engine/backend/internal/storage"
)

func TestValidateInputRejectsUnsupportedPlatformAndPrice(t *testing.T) {
	valid := domain.Input{Product: "Garrafa", Goal: "Lançamento", Platform: "TikTok", Ratio: "9:16"}
	if err := validateInput(valid); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}

	invalidPlatform := valid
	invalidPlatform.Platform = "Other"
	if err := validateInput(invalidPlatform); err == nil {
		t.Fatal("expected unsupported platform to be rejected")
	}

	invalidPrice := valid
	invalidPrice.Price = "R$ 10"
	if err := validateInput(invalidPrice); err == nil {
		t.Fatal("expected malformed price to be rejected")
	}

	zeroPrice := valid
	zeroPrice.Price = "0,00"
	if err := validateInput(zeroPrice); err == nil {
		t.Fatal("expected a zero price to be rejected")
	}

	inconsistentOffer := valid
	inconsistentOffer.Price = "149,90"
	inconsistentOffer.OriginalPrice = "89,90"
	if err := validateInput(inconsistentOffer); err == nil {
		t.Fatal("expected a promotional price above the original to be rejected")
	}

	tooLong := valid
	tooLong.Product = strings.Repeat("a", 121)
	if err := validateInput(tooLong); err == nil {
		t.Fatal("expected overlong product name to be rejected")
	}
}

func TestUploadRejectsRenamedSVG(t *testing.T) {
	images, err := storage.NewLocal(filepath.Join(t.TempDir(), "uploads"))
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("image", "product.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("<svg><script>alert(1)</script></svg>")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	server := &Server{images: images, logger: slog.Default()}

	server.upload(response, request)

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("got status %d, want %d", response.Code, http.StatusUnsupportedMediaType)
	}
}
