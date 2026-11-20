package storage

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

const MaxImageSize = 15 << 20

var imageKeyPattern = regexp.MustCompile(`^[a-f0-9]{32}\.(jpg|png|webp)$`)

type Local struct {
	root string
}

func NewLocal(root string) (*Local, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create uploads directory: %w", err)
	}
	return &Local{root: root}, nil
}

func DetectImageType(data []byte) (string, string, error) {
	switch {
	case len(data) >= 3 && bytes.Equal(data[:3], []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg", "jpg", nil
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return "image/png", "png", nil
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp", "webp", nil
	default:
		return "", "", errors.New("o arquivo não é uma imagem JPG, PNG ou WebP válida")
	}
}

func (s *Local) Save(reader io.Reader, extension string) (string, error) {
	if extension != "jpg" && extension != "png" && extension != "webp" {
		return "", errors.New("extensão de imagem inválida")
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate image key: %w", err)
	}
	key := hex.EncodeToString(random) + "." + extension

	temp, err := os.CreateTemp(s.root, ".upload-*")
	if err != nil {
		return "", fmt.Errorf("create temporary upload: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	if _, err := io.Copy(temp, io.LimitReader(reader, MaxImageSize+1)); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("write image upload: %w", err)
	}
	info, err := temp.Stat()
	if err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("stat image upload: %w", err)
	}
	if info.Size() > MaxImageSize {
		_ = temp.Close()
		return "", errors.New("a imagem deve ter no máximo 15 MB")
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("sync image upload: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("close image upload: %w", err)
	}
	if err := os.Rename(tempName, filepath.Join(s.root, key)); err != nil {
		return "", fmt.Errorf("finalize image upload: %w", err)
	}
	return key, nil
}

func (s *Local) Open(key string) (*os.File, string, error) {
	if !imageKeyPattern.MatchString(key) {
		return nil, "", os.ErrNotExist
	}
	file, err := os.Open(filepath.Join(s.root, key))
	if err != nil {
		return nil, "", err
	}
	contentType := map[string]string{
		"jpg":  "image/jpeg",
		"png":  "image/png",
		"webp": "image/webp",
	}[filepath.Ext(key)[1:]]
	return file, contentType, nil
}

func (s *Local) Exists(key string) bool {
	if !imageKeyPattern.MatchString(key) {
		return false
	}
	info, err := os.Stat(filepath.Join(s.root, key))
	return err == nil && info.Mode().IsRegular()
}
