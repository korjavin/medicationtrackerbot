package bot

import (
	"encoding/binary"
	"time"
)

// parseExifDateTimeOriginal extracts the DateTimeOriginal (tag 0x9003) from a
// JPEG byte slice's EXIF metadata. If present, OffsetTimeOriginal (tag 0x9011)
// is honoured for timezone interpretation; otherwise the timestamp is treated
// as UTC. Falls back to IFD0's DateTime (tag 0x0132) when the Exif sub-IFD
// lacks DateTimeOriginal. Returns the zero time and false for non-JPEG inputs,
// missing EXIF, malformed offsets, or out-of-range years.
func parseExifDateTimeOriginal(b []byte) (time.Time, bool) {
	if len(b) < 4 {
		return time.Time{}, false
	}
	if b[0] != 0xFF || b[1] != 0xD8 {
		return time.Time{}, false
	}
	offset := 2
	for offset+4 <= len(b) {
		if b[offset] != 0xFF {
			return time.Time{}, false
		}
		marker := b[offset+1]
		if marker == 0xDA || marker == 0xD9 {
			return time.Time{}, false
		}
		segLen := int(binary.BigEndian.Uint16(b[offset+2 : offset+4]))
		if segLen < 2 {
			return time.Time{}, false
		}
		if marker == 0xE1 && offset+4+6 <= len(b) {
			if string(b[offset+4:offset+8]) == "Exif" && b[offset+8] == 0 && b[offset+9] == 0 {
				return parseExifTiff(b, offset+10, segLen-8)
			}
		}
		offset += 2 + segLen
	}
	return time.Time{}, false
}

type exifIfdEntry struct {
	typ          uint16
	count        uint32
	valueOffset  uint32
	valueFieldAt int
}

func parseExifTiff(b []byte, tiffStart, tiffLen int) (time.Time, bool) {
	end := tiffStart + tiffLen
	if end > len(b) {
		end = len(b)
	}
	if tiffStart+8 > end {
		return time.Time{}, false
	}
	byteOrder := binary.BigEndian.Uint16(b[tiffStart : tiffStart+2])
	var order binary.ByteOrder
	switch byteOrder {
	case 0x4949:
		order = binary.LittleEndian
	case 0x4D4D:
		order = binary.BigEndian
	default:
		return time.Time{}, false
	}
	if order.Uint16(b[tiffStart+2:tiffStart+4]) != 0x002A {
		return time.Time{}, false
	}
	ifd0Off := tiffStart + int(order.Uint32(b[tiffStart+4:tiffStart+8]))
	ifd0, ok := readExifIfd(b, ifd0Off, end, order)
	if !ok {
		return time.Time{}, false
	}

	var dateTimeFallback string
	if e, ok := ifd0[0x0132]; ok {
		dateTimeFallback, _ = readExifAscii(b, tiffStart, end, e, order)
	}

	var dateTimeOriginal, offsetTimeOriginal string
	if exifPtr, ok := ifd0[0x8769]; ok {
		exifTags, ok2 := readExifIfd(b, tiffStart+int(exifPtr.valueOffset), end, order)
		if ok2 {
			if e, ok := exifTags[0x9003]; ok {
				dateTimeOriginal, _ = readExifAscii(b, tiffStart, end, e, order)
			}
			if e, ok := exifTags[0x9011]; ok {
				offsetTimeOriginal, _ = readExifAscii(b, tiffStart, end, e, order)
			}
		}
	}

	s := dateTimeOriginal
	if s == "" {
		s = dateTimeFallback
	}
	return parseExifDateString(s, offsetTimeOriginal)
}

func readExifIfd(b []byte, ifdOffset, end int, order binary.ByteOrder) (map[uint16]exifIfdEntry, bool) {
	if ifdOffset < 0 || ifdOffset+2 > end {
		return nil, false
	}
	count := int(order.Uint16(b[ifdOffset : ifdOffset+2]))
	if ifdOffset+2+count*12 > end {
		return nil, false
	}
	tags := make(map[uint16]exifIfdEntry, count)
	for i := 0; i < count; i++ {
		e := ifdOffset + 2 + i*12
		tag := order.Uint16(b[e : e+2])
		typ := order.Uint16(b[e+2 : e+4])
		cnt := order.Uint32(b[e+4 : e+8])
		valOff := order.Uint32(b[e+8 : e+12])
		tags[tag] = exifIfdEntry{
			typ:          typ,
			count:        cnt,
			valueOffset:  valOff,
			valueFieldAt: e + 8,
		}
	}
	return tags, true
}

func readExifAscii(b []byte, tiffStart, end int, entry exifIfdEntry, _ binary.ByteOrder) (string, bool) {
	if entry.typ != 2 || entry.count == 0 {
		return "", false
	}
	length := int(entry.count)
	var strStart int
	if length <= 4 {
		strStart = entry.valueFieldAt
	} else {
		strStart = tiffStart + int(entry.valueOffset)
	}
	if strStart < 0 || strStart+length > len(b) {
		return "", false
	}
	out := make([]byte, 0, length)
	for i := 0; i < length; i++ {
		c := b[strStart+i]
		if c == 0 {
			break
		}
		out = append(out, c)
	}
	return string(out), true
}

func parseExifDateString(s, offsetStr string) (time.Time, bool) {
	if len(s) < 19 {
		return time.Time{}, false
	}
	valid := isDigit(s[0]) && isDigit(s[1]) && isDigit(s[2]) && isDigit(s[3]) &&
		s[4] == ':' &&
		isDigit(s[5]) && isDigit(s[6]) &&
		s[7] == ':' &&
		isDigit(s[8]) && isDigit(s[9]) &&
		(s[10] == ' ' || s[10] == 'T') &&
		isDigit(s[11]) && isDigit(s[12]) &&
		s[13] == ':' &&
		isDigit(s[14]) && isDigit(s[15]) &&
		s[16] == ':' &&
		isDigit(s[17]) && isDigit(s[18])
	if !valid {
		return time.Time{}, false
	}
	year := intFromDigits(s[0:4])
	mon := intFromDigits(s[5:7])
	day := intFromDigits(s[8:10])
	hour := intFromDigits(s[11:13])
	minute := intFromDigits(s[14:16])
	sec := intFromDigits(s[17:19])

	loc := time.UTC
	if len(offsetStr) == 6 && (offsetStr[0] == '+' || offsetStr[0] == '-') &&
		isDigit(offsetStr[1]) && isDigit(offsetStr[2]) &&
		offsetStr[3] == ':' &&
		isDigit(offsetStr[4]) && isDigit(offsetStr[5]) {
		oh := intFromDigits(offsetStr[1:3])
		om := intFromDigits(offsetStr[4:6])
		offsetSecs := oh*3600 + om*60
		if offsetStr[0] == '-' {
			offsetSecs = -offsetSecs
		}
		loc = time.FixedZone("EXIF", offsetSecs)
	}
	dt := time.Date(year, time.Month(mon), day, hour, minute, sec, 0, loc)
	yr := dt.Year()
	if yr < 1995 || yr > time.Now().Year()+1 {
		return time.Time{}, false
	}
	return dt, true
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func intFromDigits(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		n = n*10 + int(s[i]-'0')
	}
	return n
}
