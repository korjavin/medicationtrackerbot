package gojaspike

import (
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/dop251/goja"
	"github.com/korjavin/medicationtrackerbot/internal/store/db"
	_ "modernc.org/sqlite"
)

func TestMemUsage(t *testing.T) {
	d, _ := db.Open(":memory:")
	defer d.Close()

	bpJSBytes, _ := os.ReadFile("../../web/domain/bp.js")
	code := string(bpJSBytes)
	code = strings.ReplaceAll(code, "export function", "function")
	code = strings.ReplaceAll(code, "export const", "const")

    runtime.GC()
	var m1 runtime.MemStats
	runtime.ReadMemStats(&m1)

    // instantiate 100 VMs
    vms := make([]*goja.Runtime, 100)
    for i := 0; i < 100; i++ {
        vm := goja.New()
        vm.RunString(code)
        vms[i] = vm
    }

    var m2 runtime.MemStats
    runtime.ReadMemStats(&m2)

	alloc := m2.Alloc - m1.Alloc
    allocPerVM := alloc / 100
    t.Logf("Memory per VM (pre-GC): %d bytes (%.2f MB)", allocPerVM, float64(allocPerVM)/1024/1024)
}
