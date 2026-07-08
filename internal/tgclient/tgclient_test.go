package tgclient

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSetMyProfilePhotoMultipartShape(t *testing.T) {
	var gotContentType string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		b, err := io.ReadAll(r.Body)
		if err == nil {
			gotBody = b
		}
		w.Write([]byte(`{"ok": true, "result": true}`))
	}))
	defer srv.Close()

	client := New("dummy_token", srv.URL)
	err := client.SetMyProfilePhoto(context.Background(), []byte("fake_image_data"))
	if err != nil {
		t.Fatalf("SetMyProfilePhoto failed: %v", err)
	}

	if !strings.HasPrefix(gotContentType, "multipart/form-data; boundary=") {
		t.Errorf("expected multipart/form-data, got %q", gotContentType)
	}

	bodyStr := string(gotBody)
	if !strings.Contains(bodyStr, `name="photo"`) {
		t.Errorf("missing photo field name")
	}
	if !strings.Contains(bodyStr, `{"type":"static","photo":"attach://profile_photo"}`) {
		t.Errorf("missing correct JSON for photo field")
	}
	if !strings.Contains(bodyStr, `name="profile_photo"`) {
		t.Errorf("missing profile_photo file part name")
	}
	if !strings.Contains(bodyStr, "fake_image_data") {
		t.Errorf("missing image payload")
	}
}
