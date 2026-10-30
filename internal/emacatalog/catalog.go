// Package emacatalog projects the pinned EMA Article 57 workbook using only
// columns A-D. The workbook itself contains contacts and must never be vendored.
package emacatalog

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
)

const SourceURL = "https://www.ema.europa.eu/en/documents/other/article-57-product-data_en.xlsx"
const PageURL = "https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/data-medicines-iso-idmp-standards-post-authorisation/public-data-article-57-database"
const ReuseURL = "https://www.ema.europa.eu/en/about-us/about-website/legal-notice"

// Source is the reviewed release lock, copied into every generated catalogue.
type Source struct {
	URL           string `json:"url"`
	PageURL       string `json:"page_url"`
	Revision      string `json:"revision"`
	DataDate      string `json:"data_date"`
	PublishedDate string `json:"published_date"`
	SHA256        string `json:"sha256"`
	ReuseURL      string `json:"reuse_url"`
	ReuseChecked  string `json:"reuse_checked"`
	Attribution   string `json:"attribution"`
}

// Row is deliberately positional: no unreviewed workbook field can leak through.
// Substance text is opaque, including salts, punctuation and product separators.
type Row [4]string

type Catalogue struct {
	SchemaVersion int       `json:"schema_version"`
	Source        Source    `json:"source"`
	Columns       [4]string `json:"columns"`
	SourceRows    int       `json:"source_rows"`
	Rows          []Row     `json:"rows"`
}

var headers = [4]string{
	"Product name\n\nProduct short name: brand name or the combination of the generic name and the company name",
	"Active substance\n\n\nThe symbol \"|\" is used to separate different pharmaceutical products",
	"Route of administration",
	"Product authorisation country",
}

type cell struct {
	Ref     string   `xml:"r,attr"`
	Type    string   `xml:"t,attr"`
	Value   string   `xml:"v"`
	Inline  richText `xml:"is"`
	Formula *string  `xml:"f"`
}
type richText struct {
	Text string `xml:"t"`
	Runs []struct {
		Text string `xml:"t"`
	} `xml:"r"`
}

func (r richText) text() string {
	s := r.Text
	for _, run := range r.Runs {
		s += run.Text
	}
	return s
}

// Generate fails closed on a changed hash, workbook layout, header or data row.
// Identical four-column rows are deduplicated; all distinct candidates survive.
func Generate(input []byte, source Source) ([]byte, error) {
	hash := sha256.Sum256(input)
	if source.SHA256 != hex.EncodeToString(hash[:]) {
		return nil, fmt.Errorf("source SHA-256 mismatch")
	}
	if source.URL != SourceURL || source.PageURL != PageURL || source.ReuseURL != ReuseURL || source.Attribution == "" || source.Revision == "" || source.DataDate == "" || source.PublishedDate == "" || source.ReuseChecked == "" {
		return nil, fmt.Errorf("incomplete or unrecognised source provenance")
	}
	z, err := zip.NewReader(bytes.NewReader(input), int64(len(input)))
	if err != nil {
		return nil, fmt.Errorf("open workbook: %w", err)
	}
	files := make(map[string]*zip.File)
	sheets := 0
	for _, f := range z.File {
		if _, exists := files[f.Name]; exists {
			return nil, fmt.Errorf("duplicate workbook part")
		}
		files[f.Name] = f
		if strings.HasPrefix(f.Name, "xl/worksheets/") && strings.HasSuffix(f.Name, ".xml") {
			sheets++
		}
	}
	if sheets != 1 || files["xl/worksheets/sheet1.xml"] == nil {
		return nil, fmt.Errorf("unsupported workbook sheet layout")
	}
	shared, err := openXML(files, "xl/sharedStrings.xml")
	if err != nil {
		return nil, err
	}
	var stringsTable []string
	err = elements(shared, "si", func(d *xml.Decoder, start xml.StartElement) error {
		var text richText
		if err := d.DecodeElement(&text, &start); err != nil {
			return err
		}
		stringsTable = append(stringsTable, text.text())
		return nil
	})
	shared.Close()
	if err != nil {
		return nil, fmt.Errorf("read shared strings: %w", err)
	}
	sheet, err := openXML(files, "xl/worksheets/sheet1.xml")
	if err != nil {
		return nil, err
	}
	defer sheet.Close()
	catalogue := Catalogue{SchemaVersion: 1, Source: source, Columns: [4]string{"name", "substances", "route", "jurisdiction"}}
	seen := make(map[Row]bool)
	lastRow := 0
	var metadataSeen [3]bool
	err = elements(sheet, "row", func(d *xml.Decoder, start xml.StartElement) error {
		var row struct {
			Number int    `xml:"r,attr"`
			Cells  []cell `xml:"c"`
		}
		if err := d.DecodeElement(&row, &start); err != nil {
			return err
		}
		if row.Number <= lastRow {
			return fmt.Errorf("unordered worksheet rows")
		}
		lastRow = row.Number
		var projected Row
		var present [4]bool
		for _, c := range row.Cells {
			// Reject an invalid reference, but never decode non-allowlisted cells.
			if len(c.Ref) < 2 {
				return fmt.Errorf("invalid cell reference at row %d", row.Number)
			}
			col := int(c.Ref[0] - 'A')
			if col < 0 || col > 3 || c.Ref[1] < '0' || c.Ref[1] > '9' {
				continue
			}
			if c.Ref != string(rune('A'+col))+strconv.Itoa(row.Number) || present[col] {
				return fmt.Errorf("invalid or duplicate allowlisted cell at row %d", row.Number)
			}
			present[col] = true
			if c.Formula != nil {
				return fmt.Errorf("formula in allowlisted column at row %d", row.Number)
			}
			var value string
			switch c.Type {
			case "s":
				i, err := strconv.Atoi(c.Value)
				if err != nil || i < 0 || i >= len(stringsTable) {
					return fmt.Errorf("invalid shared string at row %d", row.Number)
				}
				value = stringsTable[i]
			case "inlineStr":
				value = c.Inline.text()
			case "", "str":
				value = c.Value
			default:
				return fmt.Errorf("unsupported cell type at row %d", row.Number)
			}
			projected[col] = value
		}
		switch row.Number {
		case 5:
			if projected[0] != "Data as present in the Article 57 database on "+source.DataDate {
				return fmt.Errorf("source data date changed")
			}
			metadataSeen[0] = true
		case 6:
			if projected[0] != source.Revision {
				return fmt.Errorf("source revision changed")
			}
			metadataSeen[1] = true
		case 20:
			if projected != headers {
				return fmt.Errorf("required A-D headers changed")
			}
			metadataSeen[2] = true
		default:
			if row.Number < 21 {
				return nil
			}
			for _, value := range projected {
				if strings.TrimSpace(value) == "" {
					return fmt.Errorf("missing required A-D value at row %d", row.Number)
				}
				if strings.ContainsRune(value, '\x00') {
					return fmt.Errorf("NUL in required A-D value at row %d", row.Number)
				}
			}
			catalogue.SourceRows++
			if !seen[projected] {
				seen[projected] = true
				catalogue.Rows = append(catalogue.Rows, projected)
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read worksheet: %w", err)
	}
	if catalogue.SourceRows == 0 {
		return nil, fmt.Errorf("empty catalogue")
	}
	if metadataSeen != [3]bool{true, true, true} {
		return nil, fmt.Errorf("missing source metadata or required headers")
	}
	slices.SortFunc(catalogue.Rows, func(a, b Row) int {
		for i := range a {
			if c := strings.Compare(a[i], b[i]); c != 0 {
				return c
			}
		}
		return 0
	})
	output, err := json.Marshal(catalogue)
	if err != nil {
		return nil, err
	}
	return append(output, '\n'), nil
}

func openXML(files map[string]*zip.File, name string) (io.ReadCloser, error) {
	f := files[name]
	if f == nil {
		return nil, fmt.Errorf("missing workbook part %s", name)
	}
	if f.UncompressedSize64 > 256<<20 {
		return nil, fmt.Errorf("workbook part too large")
	}
	return f.Open()
}
func elements(r io.Reader, name string, visit func(*xml.Decoder, xml.StartElement) error) error {
	d := xml.NewDecoder(r)
	for {
		token, err := d.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == name {
			if err := visit(d, start); err != nil {
				return err
			}
		}
	}
}
