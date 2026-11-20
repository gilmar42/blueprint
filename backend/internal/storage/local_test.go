package storage

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDetectImageTypeRequiresSupportedMagicBytes(t *testing.T) {
	tests := []struct {
		name      string
		data      []byte
		mediaType string
		extension string
		wantErr   bool
	}{
		{name: "jpeg", data: []byte{0xff, 0xd8, 0xff}, mediaType: "image/jpeg", extension: "jpg"},
		{name: "png", data: []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, mediaType: "image/png", extension: "png"},
		{name: "webp", data: []byte("RIFF0000WEBP"), mediaType: "image/webp", extension: "webp"},
		{name: "svg is rejected", data: []byte("<svg/>"), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mediaType, extension, err := DetectImageType(test.data)
			if test.wantErr {
				if err == nil {
					t.Fatal("expected an unsupported image error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if mediaType != test.mediaType || extension != test.extension {
				t.Fatalf("got %q/%q, want %q/%q", mediaType, extension, test.mediaType, test.extension)
			}
		})
	}
}

func TestLocalStorageUsesOpaqueKeysAndRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	storage, err := NewLocal(root)
	if err != nil {
		t.Fatal(err)
	}
	key, err := storage.Save(bytes.NewReader([]byte("image")), "png")
	if err != nil {
		t.Fatal(err)
	}
	if !imageKeyPattern.MatchString(key) {
		t.Fatalf("unexpected image key: %q", key)
	}
	if !storage.Exists(key) {
		t.Fatal("saved image should exist")
	}
	file, contentType, err := storage.Open(key)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if contentType != "image/png" {
		t.Fatalf("unexpected content type: %q", contentType)
	}
	if _, _, err := storage.Open("../secret"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("traversal key should be rejected, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "..", "secret")); err == nil {
		t.Fatal("test fixture unexpectedly exists outside storage")
	}
}
