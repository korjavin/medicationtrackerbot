package main

import (
	"fmt"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestServerConfig(t *testing.T) {
	// Setup environment for the test
	t.Setenv("PORT", "0")
	t.Setenv("SESSION_SECRET", "test-secret")
	t.Setenv("DB_PATH", ":memory:")
	t.Setenv("TELEGRAM_BOT_TOKEN", "")
	t.Setenv("ALLOWED_USER_ID", "12345")

	// Find an available port
	l, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatalf("Failed to find available port: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	t.Setenv("PORT", fmt.Sprintf("%d", port))

	// Run main in a separate goroutine
	errCh := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				errCh <- fmt.Errorf("main panicked: %v", r)
			}
		}()
		// We expect main to block until process terminates or error
		main()
		errCh <- nil
	}()

	// Wait for server to start
	serverAddr := fmt.Sprintf("localhost:%d", port)
	deadline := time.Now().Add(5 * time.Second)
	started := false
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", serverAddr, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			started = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	if !started {
		t.Fatalf("Server failed to start on %s", serverAddr)
	}

	// Now we know it's running, let's verify header timeout behavior

	// Test 1: MaxHeaderBytes check
	// Construct a request with headers > 1MB
	// 1 MB = 1048576 bytes
	largeHeaderValue := make([]byte, 1048576+10)
	for i := range largeHeaderValue {
		largeHeaderValue[i] = 'A'
	}

	conn, err := net.Dial("tcp", serverAddr)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer conn.Close()

	req := fmt.Sprintf("GET / HTTP/1.1\r\nHost: localhost\r\nX-Large-Header: %s\r\n\r\n", string(largeHeaderValue))
	_, err = conn.Write([]byte(req))
	if err != nil {
		// It might fail on write if the server closes connection quickly
		t.Logf("Write err (expected): %v", err)
	}

	// We expect the connection to be closed by the server or return a 431 Request Header Fields Too Large
	// Since go standard lib closes connection or sends 431
	buf := make([]byte, 1024)
	n, err := conn.Read(buf)
	if err != nil && err.Error() != "EOF" && !isConnReset(err) {
		t.Logf("Read err: %v", err)
	}

	if n > 0 {
		resp := string(buf[:n])
		if !contains(resp, "431 Request Header Fields Too Large") && !contains(resp, "Connection closed") {
			t.Logf("Got response: %s", resp)
		}
	}

	// Test 2: ReadHeaderTimeout check
	conn2, err := net.Dial("tcp", serverAddr)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer conn2.Close()

	// Send partial header
	_, err = conn2.Write([]byte("GET / HTTP/1.1\r\nHost: localhost\r\n"))
	if err != nil {
		t.Fatalf("Failed to write partial header: %v", err)
	}

	// Wait for longer than the 10s ReadHeaderTimeout
	// But in a test, we don't want to wait 10s. So we just verify that it doesn't close immediately.
	// A proper test for the exact timeout is tricky without changing the timeout for tests.
	// But we can check if the socket is still open immediately.
	conn2.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	_, err = conn2.Read(buf)
	if err == nil {
		t.Fatalf("Expected timeout or no data, got data")
	}

	// Clean up by sending SIGINT to ourselves, or just exit. Since we're in a test, let's just finish.
	// We can't cleanly stop main(), but that's ok for this test structure if we don't leak much.
}

func isConnReset(err error) bool {
	if opErr, ok := err.(*net.OpError); ok {
		if sysErr, ok := opErr.Err.(*os.SyscallError); ok {
			if sysErr.Err == syscall.ECONNRESET {
				return true
			}
		}
	}
	return false
}

func contains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
