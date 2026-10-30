package emacatalog

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
)

func fixture(t *testing.T) (Source, []Row) {
	t.Helper()
	lock, err := os.ReadFile("../../third_party/ema-article57/source.json")
	if err != nil {
		t.Fatal(err)
	}
	var source Source
	if err := json.Unmarshal(lock, &source); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("testdata/rows.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Rows []Row `json:"rows"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return source, fixture.Rows
}

// Build a tiny contact-free XLSX in memory. Non-allowlisted cells contain
// synthetic sentinels only; rich-text shared strings mirror the real headers.
func workbook(t *testing.T, source Source, rows []Row, alter func(string) string) []byte {
	t.Helper()
	var sheet strings.Builder
	sheet.WriteString(`<worksheet><sheetData>`)
	writeRow := func(n int, values Row) {
		fmt.Fprintf(&sheet, `<row r="%d">`, n)
		for i, value := range values {
			fmt.Fprintf(&sheet, `<c r="%c%d" t="inlineStr"><is><t>`, 'A'+i, n)
			xml.EscapeText(&sheet, []byte(value))
			sheet.WriteString(`</t></is></c>`)
		}
		fmt.Fprintf(&sheet, `<c r="E%d" t="inlineStr"><is><t>EXCLUDED_HOLDER</t></is></c><c r="I%d" t="s"><v>0</v></c></row>`, n, n)
	}
	writeRow(5, Row{"Data as present in the Article 57 database on " + source.DataDate})
	writeRow(6, Row{source.Revision})
	writeRow(20, headers)
	for i, row := range rows {
		writeRow(21+i, row)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	if alter != nil {
		s := alter(sheet.String())
		sheet.Reset()
		sheet.WriteString(s)
	}
	var output bytes.Buffer
	z := zip.NewWriter(&output)
	for _, part := range [][2]string{
		{"xl/sharedStrings.xml", `<sst><si><r><t>EXCLUDED_</t></r><r><t>CONTACT</t></r></si></sst>`},
		{"xl/worksheets/sheet1.xml", sheet.String()},
	} {
		w, err := z.Create(part[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(part[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
func pin(source Source, input []byte) Source {
	hash := sha256.Sum256(input)
	source.SHA256 = hex.EncodeToString(hash[:])
	return source
}

func TestGeneratePreservesWholeSourceCandidates(t *testing.T) {
	source, rows := fixture(t)
	// Duplicate rows represent one identical candidate, never a first-wins choice.
	input := workbook(t, source, append(rows, rows[0]), nil)
	source = pin(source, input)
	first, err := Generate(input, source)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Generate(input, source)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("generation is nondeterministic")
	}
	if bytes.Contains(first, []byte("EXCLUDED")) {
		t.Fatal("excluded column leaked")
	}
	var got Catalogue
	if err := json.Unmarshal(first, &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != source || got.SchemaVersion != 1 || got.SourceRows != len(rows)+1 || len(got.Rows) != len(rows) {
		t.Fatal("lost provenance/counts")
	}
	for _, row := range rows {
		if !slices.Contains(got.Rows, row) {
			t.Fatalf("lost original candidate for %s", row[0])
		}
	}
	// Input order cannot affect the sorted projection (only its source hash).
	slices.Reverse(rows)
	reversed := workbook(t, source, append(rows, rows[0]), nil)
	reversedBytes, err := Generate(reversed, pin(source, reversed))
	if err != nil {
		t.Fatal(err)
	}
	var reverseCatalogue Catalogue
	json.Unmarshal(reversedBytes, &reverseCatalogue)
	if !slices.Equal(got.Rows, reverseCatalogue.Rows) {
		t.Fatal("output depends on source ordering")
	}
}

func TestGenerateRejectsSourceDrift(t *testing.T) {
	source, rows := fixture(t)
	for _, test := range []struct {
		name  string
		alter func(string) string
	}{
		{"missing header", func(s string) string { return strings.Replace(s, `r="20"`, `r="19"`, 1) }},
		{"changed header", func(s string) string { return strings.Replace(s, "Route of administration", "Route", 1) }},
		{"missing column", func(s string) string { return strings.Replace(s, "Candesartan Cilexetil", "", 1) }},
		{"changed revision", func(s string) string { return strings.Replace(s, source.Revision, "changed", 1) }},
		{"changed date", func(s string) string { return strings.Replace(s, source.DataDate, "changed", 1) }},
		{"bad shared index", func(s string) string {
			return strings.Replace(s, `r="A21" t="inlineStr"><is><t>Candecor</t></is>`, `r="A21" t="s"><v>99999</v>`, 1)
		}},
		{"formula", func(s string) string {
			return strings.Replace(s, `r="A21" t="inlineStr">`, `r="A21" t="inlineStr"><f>1+1</f>`, 1)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := workbook(t, source, rows, test.alter)
			if _, err := Generate(input, pin(source, input)); err == nil {
				t.Fatal("accepted changed source")
			}
		})
	}
	input := workbook(t, source, rows, nil)
	if _, err := Generate(input, source); err == nil {
		t.Fatal("accepted incorrect source hash")
	}
	if _, err := Generate([]byte("not an XLSX"), pin(source, []byte("not an XLSX"))); err == nil {
		t.Fatal("accepted malformed workbook")
	}
}

func TestGenerateSharedRichTextAndOriginalWhitespace(t *testing.T) {
	source, _ := fixture(t)
	rows := []Row{{" Amlodipin !@ctavis\n", "Salt, Combination | Another Product", "Oral Use\t", "Austria"}}
	input := workbook(t, source, rows, func(s string) string {
		return strings.Replace(s, `r="A21" t="inlineStr"><is><t> Amlodipin !@ctavis&#xA;</t></is>`, `r="A21" t="s"><v>0</v>`, 1)
	})
	// Rich text is exercised by decoding the non-contact synthetic sentinel as
	// an allowlisted value; original whitespace is checked in the other columns.
	output, err := Generate(input, pin(source, input))
	if err != nil {
		t.Fatal(err)
	}
	var got Catalogue
	json.Unmarshal(output, &got)
	if got.Rows[0][0] != "EXCLUDED_CONTACT" || got.Rows[0][1] != rows[0][1] || got.Rows[0][2] != rows[0][2] {
		t.Fatal("rich text or original whitespace lost")
	}
}
