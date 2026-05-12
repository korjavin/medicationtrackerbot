package bot

import (
	"encoding/binary"
	"testing"
	"time"
)

// buildJPEGWithExif assembles a minimal JPEG-SOI + APP1/Exif segment whose
// TIFF block contains an IFD0 pointing to an Exif sub-IFD with the supplied
// DateTimeOriginal (tag 0x9003) and optional OffsetTimeOriginal (tag 0x9011).
// The bytes after the APP1 segment are an end-of-image (EOI) marker so the
// outer parser sees a well-formed segment boundary.
func buildJPEGWithExif(t *testing.T, dateTime, offsetTime string, little bool) []byte {
	t.Helper()

	// Build the TIFF payload first, then prepend the APP1 header with the
	// correct segment length.
	var order binary.ByteOrder
	if little {
		order = binary.LittleEndian
	} else {
		order = binary.BigEndian
	}

	// TIFF header: byte-order(2) + magic(2) + ifd0_offset(4) = 8 bytes.
	tiff := make([]byte, 8)
	if little {
		tiff[0], tiff[1] = 0x49, 0x49
	} else {
		tiff[0], tiff[1] = 0x4D, 0x4D
	}
	order.PutUint16(tiff[2:4], 0x002A)
	order.PutUint32(tiff[4:8], 8) // IFD0 starts immediately after the header.

	// IFD0 has 1 entry: Exif sub-IFD pointer (tag 0x8769, type LONG).
	// Layout: count(2) + entry(12) + next_ifd(4) = 18 bytes.
	exifIfdOffset := uint32(8 + 18) // immediately after IFD0

	ifd0 := make([]byte, 18)
	order.PutUint16(ifd0[0:2], 1)      // entry count
	order.PutUint16(ifd0[2:4], 0x8769) // tag = Exif IFD pointer
	order.PutUint16(ifd0[4:6], 4)      // type = LONG
	order.PutUint32(ifd0[6:10], 1)     // count = 1
	order.PutUint32(ifd0[10:14], exifIfdOffset)
	order.PutUint32(ifd0[14:18], 0) // next IFD offset = 0

	// Build the Exif sub-IFD: variable entries depending on whether
	// OffsetTimeOriginal is included.
	entryCount := uint16(1)
	if offsetTime != "" {
		entryCount = 2
	}
	subIfdHeaderLen := 2 + int(entryCount)*12 + 4

	// DateTimeOriginal is "YYYY:MM:DD HH:MM:SS\0" = 20 bytes; pulled into the
	// data area (longer than 4 bytes).
	dtBytes := append([]byte(dateTime), 0)
	// OffsetTimeOriginal is "+HH:MM\0" = 7 bytes; also in the data area.
	var offBytes []byte
	if offsetTime != "" {
		offBytes = append([]byte(offsetTime), 0)
	}

	// Data area follows the sub-IFD header.
	dataAreaStart := exifIfdOffset + uint32(subIfdHeaderLen)
	dtOffset := dataAreaStart
	offOffset := dtOffset + uint32(len(dtBytes))

	subIfd := make([]byte, subIfdHeaderLen)
	order.PutUint16(subIfd[0:2], entryCount)
	// Entry 1: DateTimeOriginal (0x9003, ASCII type=2)
	order.PutUint16(subIfd[2:4], 0x9003)
	order.PutUint16(subIfd[4:6], 2)
	order.PutUint32(subIfd[6:10], uint32(len(dtBytes)))
	order.PutUint32(subIfd[10:14], dtOffset)
	pos := 14
	if offsetTime != "" {
		// Entry 2: OffsetTimeOriginal (0x9011, ASCII)
		order.PutUint16(subIfd[pos:pos+2], 0x9011)
		order.PutUint16(subIfd[pos+2:pos+4], 2)
		order.PutUint32(subIfd[pos+4:pos+8], uint32(len(offBytes)))
		order.PutUint32(subIfd[pos+8:pos+12], offOffset)
		pos += 12
	}
	// next IFD offset (= 0) lives at subIfd[pos:pos+4]; already zero.

	tiff = append(tiff, ifd0...)
	tiff = append(tiff, subIfd...)
	tiff = append(tiff, dtBytes...)
	if offsetTime != "" {
		tiff = append(tiff, offBytes...)
	}

	// APP1 payload = "Exif\0\0" + TIFF.
	app1 := append([]byte("Exif\x00\x00"), tiff...)
	segLen := uint16(len(app1) + 2)

	// JPEG: SOI(2) + APP1 marker(2) + segLen(2) + app1 + EOI(2).
	out := []byte{0xFF, 0xD8, 0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(out[4:6], segLen)
	out = append(out, app1...)
	out = append(out, 0xFF, 0xD9)
	return out
}

func TestParseExifDateTimeOriginal_WithOffset(t *testing.T) {
	blob := buildJPEGWithExif(t, "2024:06:15 12:30:45", "+02:00", true)
	got, ok := parseExifDateTimeOriginal(blob)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	want := time.Date(2024, 6, 15, 12, 30, 45, 0, time.FixedZone("EXIF", 2*3600))
	if !got.Equal(want) {
		t.Fatalf("time mismatch: got %s, want %s", got, want)
	}
	// Sanity check: equivalent UTC instant.
	if got.UTC() != want.UTC() {
		t.Fatalf("UTC equivalence broken: got %s", got.UTC())
	}
}

func TestParseExifDateTimeOriginal_NoOffsetTreatedAsUTC(t *testing.T) {
	blob := buildJPEGWithExif(t, "2024:01:02 03:04:05", "", false)
	got, ok := parseExifDateTimeOriginal(blob)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	want := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("time mismatch: got %s, want %s", got, want)
	}
}

func TestParseExifDateTimeOriginal_NoExifSegment(t *testing.T) {
	// Plain JPEG: SOI + a non-APP1 segment + EOI.
	blob := []byte{
		0xFF, 0xD8,
		// APP0 (JFIF), length=2 just to be valid.
		0xFF, 0xE0, 0x00, 0x02,
		0xFF, 0xD9,
	}
	if _, ok := parseExifDateTimeOriginal(blob); ok {
		t.Fatalf("expected ok=false for JPEG without EXIF")
	}
}

func TestParseExifDateTimeOriginal_NonJPEG(t *testing.T) {
	png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	if _, ok := parseExifDateTimeOriginal(png); ok {
		t.Fatalf("expected ok=false for PNG bytes")
	}
}

func TestParseExifDateTimeOriginal_Truncated(t *testing.T) {
	blob := buildJPEGWithExif(t, "2024:06:15 12:30:45", "+02:00", true)
	// Pick cut-off lengths inside structural sections that must be intact for
	// any successful parse: TIFF header (offset 12-19), IFD0 (20-37), sub-IFD
	// (38-65), DateTimeOriginal data (66-85). Cutting past byte 85 would still
	// yield a valid date (offset bytes are optional), so we don't test those.
	for _, n := range []int{0, 1, 2, 3, 4, 12, 18, 30, 50, 70} {
		if _, ok := parseExifDateTimeOriginal(blob[:n]); ok {
			t.Fatalf("expected ok=false for truncated buffer (len=%d)", n)
		}
	}
}

func TestParseExifDateTimeOriginal_EmptyAndShort(t *testing.T) {
	if _, ok := parseExifDateTimeOriginal(nil); ok {
		t.Fatalf("expected ok=false for nil")
	}
	if _, ok := parseExifDateTimeOriginal([]byte{0xFF}); ok {
		t.Fatalf("expected ok=false for 1-byte slice")
	}
}

func TestParseExifDateTimeOriginal_OutOfRangeYear(t *testing.T) {
	blob := buildJPEGWithExif(t, "1900:01:01 00:00:00", "", true)
	if _, ok := parseExifDateTimeOriginal(blob); ok {
		t.Fatalf("expected ok=false for year < 1995")
	}
}
